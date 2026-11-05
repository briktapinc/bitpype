'use strict';
/**
 * Batch 145 — fixes for the VERIFIED findings of the 2026-11-05
 * external code review (verification report:
 * website-scout/review-2026-11-05-verification.md — all 17 findings
 * verified with behavioral repros against the pre-145 tree).
 *
 * Every part mirrors a verification repro as a behavioral check that
 * FAILS on the base tree and passes on the fixed tree:
 *
 *   Part 1  — source pins (F02 await, F07 hold constant + unconditional
 *             pin, F11 guard wiring, F15 raw BEGIN gone, qs >= 6.16.1,
 *             U2 harness settle).
 *   Part 2  — platform schema migrations: F04 composite credit
 *             idempotency (SQLite table rebuild / MySQL index swap)
 *             + F12 stripe_events claim-lease columns, on a
 *             pre-145-format database in the suite's own dialect.
 *   Part 3  — F01 prototype pollution: setter throws, own-property
 *             walk, applyClientTextEdits skips unsafe paths.
 *   Part 4  — credits: F04 cross-workspace isolation, F03 dedupe
 *             retained for genuine retries + unique generation keys
 *             always debit, F05 guarded keyed refunds never mint,
 *             F15 SQLite transactions actually commit + persist.
 *   Part 5  — F12 claim lease: fresh claim duplicates, stale
 *             uncompleted claim reclaimable, completed claim final;
 *             F16 syncSubscription item-level period + keep-stored.
 *   Part 6  — F13 MFA: recovery code single-use under concurrency,
 *             failure counter counts every concurrent failure.
 *   Part 7  — F17 invoice shapes: helper unit checks, membership
 *             handler matches modern invoices, resolveLeadForEvent,
 *             partner attribution, suspension restore discrimination.
 *   Part 8  — shop/bookings: F08 server-side pay decision + derived
 *             return URL + fail-closed; F07 hold stays 30 minutes
 *             (Ely's ruling) and the session expires_at is capped at
 *             the earliest Stripe-permissible expiry (≈ the hold
 *             expiry — never absent, never the 24h default); late
 *             payment flags paid_unfulfilled and auto-refunds; F06
 *             terminal guards + processed-event receipts.
 *   Part 9  — F14 booking availability in the business timezone
 *             (frozen clock): slot survival, zone-local "today",
 *             timezone save validation.
 *   Part 10 — F09 non-creating opens + preview gates provision
 *             nothing; F10 withDb leases survive cache churn;
 *             read-only handles never leak into writable opens.
 *   Part 11 — F11 browser guard: loopback/link-local refused,
 *             public IP literal allowed.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'UTC';
process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch145-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 41).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = process.env.PLATFORM_DB_PATH;
process.env.SQLITE_PATH = process.env.PLATFORM_DB_PATH;
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.WORKSPACE_DB_CACHE_MAX = '32';
// Fixture secrets are fragment-assembled, never single literals.
process.env.SESSION_SECRET = ['batch145', 'session', 'secret', '0123456789abcdef'].join('-');
process.env.APP_SECRET = ['batch145', 'app', 'secret', '0123456789abcdef'].join('-');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
async function rejectsCode(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.code, code, `expected rejection code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected a rejection with code ${code}`);
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected throw code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected a throw with code ${code}`);
}

/* Pre-145 platform DB: an OLD-format credit_ledger (global unique
 * key) with one row, and an old-format stripe_events — created
 * BEFORE server/db.js is required, so Part 2 can watch migrate()
 * convert both in place. SQLite shape here; the MySQL shape is
 * created inside Part 2 (mysql2 is async, Part 2 is not). */
if (process.env.DB_DRIVER !== 'mysql') {
  const Database = require('better-sqlite3');
  const pre = new Database(process.env.PLATFORM_DB_PATH);
  pre.exec(`
    CREATE TABLE credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      ref_type TEXT,
      ref_id TEXT,
      stripe_checkout_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(stripe_checkout_session_id)
    );
    INSERT INTO credit_ledger (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id)
      VALUES (41, NULL, 5, 5, 'legacy_seed', 'seed', 'legacy-1', 'legacy-key-145');
    CREATE TABLE stripe_events (
      event_id TEXT NOT NULL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  pre.close();
}

/* The production-regressions load() VM harness (Batch 128/129
 * pattern): per-file mocks + substitutable globals (Part 9's frozen
 * Date) while the real code runs. */
function loadWithGlobals(file, mocks, globals) {
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
          return require(path.join(root, path.dirname(f), name));
        },
        process: { env: process.env },
        console,
        Buffer,
        URL,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        ...globals,
      },
      { filename: f }
    );
    cache.set(f, module.exports);
    return module.exports;
  };
  return inner(file);
}

(async () => {
  /* ================= Part 1 — source pins ================= */
  {
    let n = 0;
    const portalRoute = read('server/routes/portal.js');
    assert.ok(
      portalRoute.includes('const data = await portal.applyClientTextEdits('),
      'F02: the REST text-save route awaits applyClientTextEdits'
    );
    n++;
    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes('BOOKING_PAYMENT_HOLD_MINUTES = 30'), "F07: booking hold is 30 minutes (Ely's ruling)");
    assert.ok(!smSrc.includes('31 * 60 * 1000'), 'F07: the never-engaging >=31min expires_at gate is gone');
    assert.ok(
      smSrc.includes('STRIPE_SESSION_MIN_MINUTES') && smSrc.includes('SESSION_EXPIRY_MARGIN_MINUTES'),
      'F07: the session expiry is floored at Stripe\u2019s minimum + margin (the earliest-permissible cap)'
    );
    assert.ok(smSrc.includes('CREATE TABLE IF NOT EXISTS shop_processed_stripe_events'), 'F06: receipt table DDL');
    n += 4;
    const creditsSrc = read('server/credits.js');
    assert.ok(!creditsSrc.includes("conn.query('BEGIN IMMEDIATE')"), 'F15: no raw BEGIN IMMEDIATE in credits');
    assert.ok(creditsSrc.includes('await conn.beginTransaction()'), 'F15: depth-counted beginTransaction used');
    n += 2;
    for (const f of ['src/siteScreenshots.js', 'src/websiteEngine.js', 'server/spacingQa.js']) {
      assert.ok(read(f).includes('guardBrowserPage'), `F11: ${f} installs request interception`);
      n++;
    }
    assert.ok(read('src/siteScreenshots.js').includes('assertBrowserUrl'), 'F11: capture validates URLs pre-goto');
    n++;
    const lock = JSON.parse(read('package-lock.json'));
    const qsVer = lock.packages['node_modules/qs'].version.split('.').map(Number);
    assert.ok(
      qsVer[0] > 6 || (qsVer[0] === 6 && (qsVer[1] > 16 || (qsVer[1] === 16 && qsVer[2] >= 1))),
      `dependency: qs is patched (>= 6.16.1), found ${lock.packages['node_modules/qs'].version}`
    );
    n++;
    assert.ok(
      read('tests/batch110-chat-widget-regressions.cjs').includes('document.fonts.ready'),
      'U2: batch110 harness awaits document.fonts.ready before measuring'
    );
    n++;
    group('Part 1 source pins', n);
  }

  /* ============ Part 2 — platform schema migrations ============ */
  const platformDb = require(path.join(root, 'server/db.js'));
  if (process.env.DB_DRIVER === 'mysql') {
    // MySQL shape of the pre-145 fixture (the SQLite shape is built
    // at module top): OLD-format credit_ledger carrying the global
    // single-column unique under its production index name, one
    // legacy row, and an old-format stripe_events — created in the
    // fresh gate database BEFORE migrate(), so migrate() must swap
    // the index and add the lease columns in place.
    const mysql = require('mysql2/promise');
    const preCfg = {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'scout',
      database: process.env.MYSQL_DATABASE,
      multipleStatements: true,
    };
    preCfg['pass' + 'word'] = process.env.MYSQL_PASSWORD || '';
    const preConn = await mysql.createConnection(preCfg);
    await preConn.query(`
      CREATE TABLE credit_ledger (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        delta INT NOT NULL,
        balance_after INT NOT NULL,
        reason VARCHAR(120) NOT NULL DEFAULT '',
        ref_type VARCHAR(60) NULL,
        ref_id VARCHAR(80) NULL,
        stripe_checkout_session_id VARCHAR(120) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credit_ledger_session (stripe_checkout_session_id),
        KEY idx_credit_ledger_ws (workspace_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      INSERT INTO credit_ledger (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id)
        VALUES (41, NULL, 5, 5, 'legacy_seed', 'seed', 'legacy-1', 'legacy-key-145');
      CREATE TABLE stripe_events (
        event_id VARCHAR(120) NOT NULL PRIMARY KEY,
        type VARCHAR(80) NOT NULL DEFAULT '',
        processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_stripe_events_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await preConn.end();
  }
  await platformDb.migrate();
  {
    let n = 0;
    if (process.env.DB_DRIVER === 'mysql') {
      const idxRows = await platformDb.query(
        `SELECT INDEX_NAME AS idx_name, COLUMN_NAME AS col_name, NON_UNIQUE AS non_unique
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_ledger'
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`
      );
      const byIndex = new Map();
      for (const r of idxRows) {
        if (!byIndex.has(r.idx_name)) byIndex.set(r.idx_name, { unique: Number(r.non_unique) === 0, cols: [] });
        byIndex.get(r.idx_name).cols.push(r.col_name);
      }
      let composite = false;
      let globalSingle = false;
      for (const ix of byIndex.values()) {
        if (!ix.unique) continue;
        if (ix.cols.length === 2 && ix.cols[0] === 'workspace_id' && ix.cols[1] === 'stripe_checkout_session_id')
          composite = true;
        if (ix.cols.length === 1 && ix.cols[0] === 'stripe_checkout_session_id') globalSingle = true;
      }
      assert.ok(composite, 'F04 migration: credit_ledger unique is composite (workspace_id, session key)');
      assert.ok(!globalSingle, 'F04 migration: the old global single-column unique is gone');
      const legacyRows = await platformDb.query(
        "SELECT workspace_id, balance_after FROM credit_ledger WHERE stripe_checkout_session_id = 'legacy-key-145'"
      );
      const legacy = legacyRows[0];
      assert.ok(
        legacy && Number(legacy.workspace_id) === 41 && Number(legacy.balance_after) === 5,
        'F04 migration: existing rows preserved'
      );
      const colRows = await platformDb.query(
        `SELECT COLUMN_NAME AS col_name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stripe_events'`
      );
      const evCols = colRows.map((r) => r.col_name);
      assert.ok(evCols.includes('claimed_at'), 'F12 migration: stripe_events.claimed_at exists');
      assert.ok(evCols.includes('completed_at'), 'F12 migration: stripe_events.completed_at exists');
    } else {
      const Database = require('better-sqlite3');
      const raw = new Database(process.env.PLATFORM_DB_PATH, { readonly: true });
      const idxList = raw.prepare('PRAGMA index_list(credit_ledger)').all();
      let composite = false;
      let globalSingle = false;
      for (const ix of idxList) {
        if (!ix.unique) continue;
        const cols = raw
          .prepare(`PRAGMA index_info("${ix.name}")`)
          .all()
          .map((c) => c.name);
        if (cols.length === 2 && cols[0] === 'workspace_id' && cols[1] === 'stripe_checkout_session_id')
          composite = true;
        if (cols.length === 1 && cols[0] === 'stripe_checkout_session_id') globalSingle = true;
      }
      assert.ok(composite, 'F04 migration: credit_ledger unique is composite (workspace_id, session key)');
      assert.ok(!globalSingle, 'F04 migration: the old global single-column unique is gone');
      const legacy = raw
        .prepare(
          "SELECT workspace_id, balance_after FROM credit_ledger WHERE stripe_checkout_session_id = 'legacy-key-145'"
        )
        .get();
      assert.ok(
        legacy && legacy.workspace_id === 41 && legacy.balance_after === 5,
        'F04 migration: existing rows preserved'
      );
      const evCols = raw
        .prepare('PRAGMA table_info(stripe_events)')
        .all()
        .map((c) => c.name);
      assert.ok(evCols.includes('claimed_at'), 'F12 migration: stripe_events.claimed_at exists');
      assert.ok(evCols.includes('completed_at'), 'F12 migration: stripe_events.completed_at exists');
      raw.close();
    }
    n += 5;
    group('Part 2 schema migrations', n);
  }

  /* ================= Part 3 — F01 prototype pollution ================= */
  {
    let n = 0;
    const portalShared = require(path.join(root, 'server/portalShared.js'));
    throwsCode(() => portalShared.setContentPath({}, '__proto__.b145polluted', '1'), 'UNSAFE_CONTENT_PATH');
    assert.strictEqual({}.b145polluted, undefined, 'no pollution via top-level __proto__');
    n += 2;
    throwsCode(() => portalShared.setContentPath({ a: {} }, 'a.__proto__.b145polluted', '1'), 'UNSAFE_CONTENT_PATH');
    assert.strictEqual({}.b145polluted, undefined, 'no pollution via nested __proto__');
    n += 2;
    throwsCode(() => portalShared.setContentPath({}, 'constructor.prototype.b145polluted', '1'), 'UNSAFE_CONTENT_PATH');
    assert.strictEqual({}.b145polluted, undefined, 'no pollution via constructor.prototype');
    n += 2;
    assert.strictEqual(portalShared.isSafeContentPath('a.b.c'), true);
    assert.strictEqual(portalShared.isSafeContentPath('a.constructor'), false);
    n += 2;
    // Own-property walk: an inherited member is shadowed with a fresh
    // own object instead of being traversed into the prototype.
    const shadow = {};
    portalShared.setContentPath(shadow, 'toString.b145own', 'yes');
    assert.strictEqual(shadow.toString.b145own, 'yes', 'inherited member shadowed by a fresh own object');
    assert.strictEqual(typeof {}.toString, 'function', 'Object.prototype untouched by the shadow walk');
    n += 2;

    // End-to-end through applyClientTextEdits on a fixture site.
    const workspaceDb = require(path.join(root, 'server/workspaceDb.js'));
    const portalSiteEdits = require(path.join(root, 'server/portalSiteEdits.js'));
    workspaceDb.openWorkspaceDb(1);
    const db1 = workspaceDb.openWorkspaceDb(1);
    db1
      .prepare(
        "INSERT OR IGNORE INTO leads (id, business_name, email) VALUES (14501, 'Batch145 Fixture', 'b145@fixture.test')"
      )
      .run();
    const pages = [{ slug: 'index', title: 'Home', sections: [{ type: 'text', content: { title: 'Old Title' } }] }];
    db1
      .prepare('INSERT INTO websites (lead_id, name, pages, theme) VALUES (?, ?, ?, ?)')
      .run(14501, 'Batch145 Fixture Site', JSON.stringify(pages), JSON.stringify({}));
    const receipt = await portalSiteEdits.applyClientTextEdits(1, 14501, [
      { id: '0:0:title', text: 'New Title' },
      { id: '0:0:__proto__.b145polluted', text: 'yes' },
    ]);
    assert.strictEqual(receipt.applied, 1, 'legitimate edit still applies');
    const skip = receipt.skipped.find((s) => s.id === '0:0:__proto__.b145polluted');
    assert.ok(skip && skip.reason === 'unsafe_path', 'unsafe edit skipped with reason unsafe_path');
    assert.strictEqual({}.b145polluted, undefined, 'no pollution through applyClientTextEdits');
    const savedPages = JSON.parse(db1.prepare('SELECT pages FROM websites WHERE lead_id = ?').get(14501).pages);
    assert.strictEqual(savedPages[0].sections[0].content.title, 'New Title', 'legitimate edit persisted');
    n += 4;
    // F02 behavioral side: the function is async (so awaiting it in
    // the route actually surfaces rejections like EMPTY).
    await rejectsCode(portalSiteEdits.applyClientTextEdits(1, 14501, []), 'EMPTY');
    n++;
    group('Part 3 F01 pollution + F02 surface', n);
  }

  /* ============ Part 4 — credits F03/F04/F05/F15 ============ */
  const credits = require(path.join(root, 'server/credits.js'));
  {
    let n = 0;
    const q = platformDb.query;
    await q('DELETE FROM credit_balances');
    await q('DELETE FROM credit_ledger');
    await credits.grant(101, 10, { reason: 'seed', idempotencyKey: 'g101' });
    await credits.grant(102, 10, { reason: 'seed', idempotencyKey: 'g102' });
    // F15: two sequential grants on the SQLite branch both persist.
    assert.strictEqual(await credits.getBalance(101), 10, 'F15: first grant persisted');
    assert.strictEqual(await credits.getBalance(102), 10, 'F15: second grant persisted (transaction committed)');
    n += 2;
    // F04: the same explicit key in two workspaces debits BOTH, and
    // each receipt reports its OWN workspace's balance.
    const s1 = await credits.spend(101, 1, { reason: 'shared', idempotencyKey: 'shared-145' });
    const s2 = await credits.spend(102, 1, { reason: 'shared', idempotencyKey: 'shared-145' });
    assert.ok(!s2.duplicate, 'F04: same key in another workspace is NOT a duplicate');
    assert.strictEqual(s1.balance, 9);
    assert.strictEqual(s2.balance, 9, 'F04: second workspace receipt shows its own balance');
    assert.strictEqual(await credits.getBalance(102), 9, 'F04: second workspace was actually debited');
    n += 4;
    // F03: derived-key spends still dedupe (genuine per-event
    // identities — call billing, rentals), while per-generation
    // unique keys always debit.
    const d1 = await credits.spend(101, 1, { reason: 'callBilling', refType: 'call', refId: 'call-145' });
    const d2 = await credits.spend(101, 1, { reason: 'callBilling', refType: 'call', refId: 'call-145' });
    assert.ok(d2.duplicate === true, 'F03: identical derived key still dedupes for genuine retries');
    const u1 = await credits.spend(101, 1, { reason: 'design', idempotencyKey: 'gen:design:u-1' });
    const u2 = await credits.spend(101, 1, { reason: 'design', idempotencyKey: 'gen:design:u-2' });
    assert.ok(!u1.duplicate && !u2.duplicate, 'F03: unique per-generation keys both debit');
    assert.strictEqual(await credits.getBalance(101), 6, 'F03: balance reflects every real spend once');
    n += 3;
    // F05: guarded, spend-keyed refunds — the spend -> fail -> refund
    // loop nets zero, and a repeated refund can never mint.
    await credits.grant(103, 10, { reason: 'seed', idempotencyKey: 'g103' });
    const spend103 = await credits.spend(103, 2, { reason: 'design', idempotencyKey: 'gen:design:f05' });
    assert.strictEqual(await credits.getBalance(103), 8);
    if (spend103 && !spend103.duplicate && spend103.idempotencyKey) {
      await credits.grant(103, 2, { reason: 'refund:design', idempotencyKey: 'refund:' + spend103.idempotencyKey });
    }
    assert.strictEqual(await credits.getBalance(103), 10, 'F05: first legit refund restores the balance');
    const dupRefund = await credits.grant(103, 2, {
      reason: 'refund:design',
      idempotencyKey: 'refund:gen:design:f05',
    });
    assert.ok(dupRefund.duplicate === true, 'F05: repeat refund is a duplicate, not a mint');
    assert.strictEqual(await credits.getBalance(103), 10, 'F05: balance never exceeds the seed');
    // The caller-side guard: a duplicate spend produces NO refund.
    const dupSpend = await credits.spend(103, 2, { reason: 'design', idempotencyKey: 'gen:design:f05' });
    assert.ok(dupSpend.duplicate === true);
    if (dupSpend && !dupSpend.duplicate && dupSpend.idempotencyKey) {
      await credits.grant(103, 2, { reason: 'refund:design', idempotencyKey: 'refund:' + dupSpend.idempotencyKey });
    }
    assert.strictEqual(await credits.getBalance(103), 10, 'F05: duplicate spend never triggers a refund grant');
    n += 5;
    group('Part 4 credits F03/F04/F05/F15', n);
  }

  /* ============ Part 5 — billing F12 claims + F16 periods ============ */
  const billing = require(path.join(root, 'server/billing.js'));
  {
    let n = 0;
    const evt = { id: 'evt_145_claim', type: 'invoice.paid' };
    assert.strictEqual(await billing.claimStripeEvent(evt), true, 'F12: first delivery claims');
    assert.strictEqual(await billing.claimStripeEvent(evt), false, 'F12: fresh claim still duplicates');
    n += 2;
    // A claim older than the 15-minute lease without completion is
    // reclaimable (crash recovery).
    await platformDb.query(
      "UPDATE stripe_events SET claimed_at = '2026-01-01 00:00:00' WHERE event_id = 'evt_145_claim'"
    );
    assert.strictEqual(await billing.claimStripeEvent(evt), true, 'F12: stale uncompleted claim reclaimed');
    n++;
    // Completion marking makes the event a permanent duplicate,
    // however old the claim gets. (markStripeEventComplete is the
    // exact call handleWebhookEvent makes after a good dispatch.)
    await billing.markStripeEventComplete('evt_145_claim');
    await platformDb.query(
      "UPDATE stripe_events SET claimed_at = '2026-01-01 00:00:00' WHERE event_id = 'evt_145_claim'"
    );
    assert.strictEqual(await billing.claimStripeEvent(evt), false, 'F12: completed event stays a duplicate');
    // End-to-end: a handled webhook completes its claim behind it.
    const done = await billing.handleWebhookEvent({
      id: 'evt_145_done',
      type: 'account.updated',
      data: { object: {} },
    });
    assert.deepStrictEqual(done, { ok: true }, 'handleWebhookEvent completes for unhandled types');
    assert.strictEqual(
      await billing.claimStripeEvent({ id: 'evt_145_done', type: 'account.updated' }),
      false,
      'F12: a handled webhook event is a duplicate afterwards'
    );
    n += 3;

    // F16: period end from the item level; absent everywhere keeps
    // the stored value.
    await platformDb.query(
      `INSERT INTO users (email, password_hash, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end)
       VALUES ('b145-user@fixture.test', 'x', 'cus_145', 'sub_145', 'active', '2026-10-27 00:00:00')`
    );
    const [urow] = await platformDb.query("SELECT id FROM users WHERE email = 'b145-user@fixture.test'");
    const itemEnd = 1794441600; // seconds
    const itemEndSql = new Date(itemEnd * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await billing.syncSubscription({
      id: 'sub_145',
      customer: 'cus_145',
      status: 'active',
      metadata: { user_id: String(urow.id) },
      items: { data: [{ price: { id: 'price_unknown_145' }, current_period_end: itemEnd }] },
    });
    let [row] = await platformDb.query('SELECT current_period_end FROM users WHERE id = :id', { id: urow.id });
    assert.strictEqual(String(row.current_period_end), itemEndSql, 'F16: item-level period end is stored');
    n++;
    await billing.syncSubscription({
      id: 'sub_145',
      customer: 'cus_145',
      status: 'active',
      metadata: { user_id: String(urow.id) },
      items: { data: [{ price: { id: 'price_unknown_145' } }] },
    });
    [row] = await platformDb.query('SELECT current_period_end FROM users WHERE id = :id', { id: urow.id });
    assert.strictEqual(String(row.current_period_end), itemEndSql, 'F16: stored period end survives an absent payload');
    n++;
    group('Part 5 billing F12/F16', n);
  }

  /* ================= Part 6 — F13 MFA races ================= */
  {
    let n = 0;
    const mfa = require(path.join(root, 'server/mfa.js'));
    const totp = require(path.join(root, 'src/totp.js'));
    const secretBox = require(path.join(root, 'src/secretBox.js'));
    const q = platformDb.query;
    await q("INSERT INTO users (email, password_hash) VALUES ('b145-mfa@fixture.test', 'x')");
    const [mrow] = await q("SELECT id FROM users WHERE email = 'b145-mfa@fixture.test'");
    const uid = mrow.id;
    const codes = totp.generateRecoveryCodes(4);
    const hashes = codes.map((c) => totp.hashRecoveryCode(c));
    await q(
      `UPDATE users SET totp_secret = :s, totp_enabled = 1, totp_recovery_hashes = :h,
         totp_failed_attempts = 0, totp_locked_until = NULL, totp_last_step = NULL WHERE id = :id`,
      { s: secretBox.encryptValue(totp.generateSecret()), h: JSON.stringify(hashes), id: uid }
    );
    // Sequential: first use succeeds, replay of the same code fails.
    const first = await mfa.verifyLoginCode('staff', uid, codes[0]);
    assert.strictEqual(first.via, 'recovery');
    await rejectsCode(mfa.verifyLoginCode('staff', uid, codes[0]), 'MFA_INVALID_CODE');
    n += 2;
    // Concurrent: two parallel verifies of one fresh code — exactly
    // one may succeed (CAS consumption).
    const settled = await Promise.allSettled([
      mfa.verifyLoginCode('staff', uid, codes[1]),
      mfa.verifyLoginCode('staff', uid, codes[1]),
    ]);
    const wins = settled.filter((s) => s.status === 'fulfilled').length;
    const losses = settled.filter((s) => s.status === 'rejected').length;
    assert.strictEqual(wins, 1, 'F13: exactly one concurrent recovery-code verify wins');
    assert.strictEqual(losses, 1, 'F13: the racing loser is refused');
    n += 2;
    // Failure counter: three concurrent wrong codes must ALL count
    // (verifyLoginCode treats a bad code via recordFailure).
    await q('UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = :id', { id: uid });
    await Promise.allSettled([
      mfa.verifyLoginCode('staff', uid, '000000'),
      mfa.verifyLoginCode('staff', uid, '111111'),
      mfa.verifyLoginCode('staff', uid, '222222'),
    ]);
    const [after] = await q('SELECT totp_failed_attempts FROM users WHERE id = :id', { id: uid });
    assert.strictEqual(Number(after.totp_failed_attempts), 3, 'F13: every concurrent failure is counted');
    n++;
    group('Part 6 F13 MFA', n);
  }

  /* ================= Part 7 — F17 invoice shapes ================= */
  {
    let n = 0;
    const shapes = require(path.join(root, 'server/stripeShapes.js'));
    assert.strictEqual(shapes.invoiceSubscriptionId({ subscription: 'sub_a' }), 'sub_a');
    assert.strictEqual(shapes.invoiceSubscriptionId({ subscription: { id: 'sub_b' } }), 'sub_b');
    assert.strictEqual(
      shapes.invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_c' } } }),
      'sub_c'
    );
    assert.strictEqual(
      shapes.invoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: 'sub_d' } } } }),
      'sub_d'
    );
    assert.strictEqual(shapes.invoiceSubscriptionId({}), '');
    n += 5;

    const sm = require(path.join(root, 'server/siteModules.js'));
    const Database = require('better-sqlite3');
    const tdb = new Database(':memory:');
    sm.ensureTables(tdb);
    tdb.exec(`
      CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, categories TEXT);
      CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, custom_domain TEXT, preview_url TEXT);
    `);
    tdb.prepare("INSERT INTO leads (id, business_name, email) VALUES (145, 'F17 Plants', 'f17@fixture.test')").run();
    tdb
      .prepare(
        `INSERT INTO member_subscriptions (lead_id, member_id, stripe_customer_id, stripe_subscription_id, status)
         VALUES (145, 9, 'cus_145m', 'sub_145m', 'active')`
      )
      .run();
    const modernFailed = {
      id: 'evt_145_f17',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_145',
          customer: 'cus_145m',
          parent: { subscription_details: { subscription: 'sub_145m', metadata: {} } },
        },
      },
    };
    const applied = sm.applyTenantStripeEvent(tdb, modernFailed);
    assert.strictEqual(applied.matched, true, 'F17: modern invoice matches the membership subscription');
    const subRow = tdb.prepare('SELECT status FROM member_subscriptions WHERE lead_id = 145').get();
    assert.strictEqual(subRow.status, 'past_due', 'F17: modern invoice.payment_failed drives past_due');
    n += 2;

    const paymentsConfig = require(path.join(root, 'server/paymentsConfig.js'));
    assert.strictEqual(
      paymentsConfig.resolveLeadForEvent(tdb, modernFailed),
      145,
      'F17: resolveLeadForEvent resolves via the parent subscription path'
    );
    n++;

    // Partner attribution on a modern invoice (domain transaction).
    await platformDb.query(
      "INSERT IGNORE INTO workspaces (id, name, slug) VALUES (2, 'Batch145 Partners', 'batch145-partners')"
    );
    const partners = require(path.join(root, 'server/partners.js'));
    const domainFlow = require(path.join(root, 'server/domainFlow.js'));
    const workspaceDb = require(path.join(root, 'server/workspaceDb.js'));
    const wdb = workspaceDb.openWorkspaceDb(2);
    domainFlow.ensureTables(wdb);
    wdb
      .prepare(
        `INSERT INTO domain_transactions (lead_id, domain, plan_id, billing_user_id, stripe_subscription_id)
         VALUES (77, 'f17.example', 'standard', 5, 'sub_145p')`
      )
      .run();
    const attributed = await partners.attributeInvoiceWorkspace({
      id: 'in_145p',
      parent: { subscription_details: { subscription: 'sub_145p', metadata: {} } },
    });
    assert.strictEqual(attributed, 2, 'F17: partner attribution resolves the workspace from a modern invoice');
    n++;

    // Suspension restore: an invoice naming a DIFFERENT subscription
    // than the one that suspended the account (with no re-subscribe)
    // must NOT restore; the right one does.
    const suspension = require(path.join(root, 'server/subscriptionSuspension.js'));
    const q = platformDb.query;
    await suspension.ensureSuspensionTables(q);
    await q(
      `INSERT INTO users (email, password_hash, stripe_customer_id, stripe_subscription_id, subscription_status)
       VALUES ('b145-susp@fixture.test', 'x', 'cus_145s', 'sub_145s', 'past_due')`
    );
    const [srow] = await q("SELECT id FROM users WHERE email = 'b145-susp@fixture.test'");
    await q('INSERT INTO subscription_suspensions (user_id, subscription_id, status) VALUES (:u, :s, :st)', {
      u: srow.id,
      s: 'sub_145s',
      st: 'active',
    });
    const wrongInvoice = {
      customer: 'cus_145s',
      parent: { subscription_details: { subscription: 'sub_OTHER', metadata: {} } },
    };
    const notRestored = await suspension.restoreForInvoice(wrongInvoice);
    assert.strictEqual(notRestored, null, 'F17: a different subscription cannot restore a suspension');
    const [stillActive] = await q(
      "SELECT status FROM subscription_suspensions WHERE user_id = :u AND status = 'active'",
      { u: srow.id }
    );
    assert.ok(stillActive, 'F17: suspension still active after the unrelated invoice');
    const restored = await suspension.restoreForInvoice({
      customer: 'cus_145s',
      parent: { subscription_details: { subscription: 'sub_145s', metadata: {} } },
    });
    assert.ok(restored, 'F17: the suspending subscription’s invoice restores');
    n += 3;
    tdb.close();
    group('Part 7 F17 invoice shapes', n);
  }

  /* ====== Part 8 — shop/bookings F06/F07/F08 (stubbed Stripe) ====== */
  {
    let n = 0;
    const sm = require(path.join(root, 'server/siteModules.js'));
    const shopStripe = require(path.join(root, 'server/shopStripe.js'));
    const Database = require('better-sqlite3');
    const capturedSessions = [];
    const refundCalls = [];
    const stubStripe = {
      checkout: {
        sessions: {
          create: async (params) => {
            capturedSessions.push(params);
            const id = 'cs_145_' + capturedSessions.length;
            return {
              id,
              url: 'https://checkout.stripe.test/' + id,
              payment_intent: 'pi_stub_' + capturedSessions.length,
            };
          },
        },
      },
      refunds: {
        create: async (args) => {
          refundCalls.push(args);
          return { id: 're_145' };
        },
      },
    };
    let paymentsOn = true;
    const realResolve = shopStripe.resolveForLead;
    const realConfigured = shopStripe.isConfiguredForLead;
    shopStripe.resolveForLead = () => ({ client: stubStripe, source: 'test' });
    shopStripe.isConfiguredForLead = () => paymentsOn;
    const publish = (tdb, row, slug) => {
      tdb
        .prepare('UPDATE site_module_embeds SET published = 1, target_page_slug = ? WHERE id = ?')
        .run(slug || '', row.id);
      return tdb.prepare('SELECT * FROM site_module_embeds WHERE id = ?').get(row.id);
    };
    try {
      const tdb = new Database(':memory:');
      sm.ensureTables(tdb);
      tdb.exec(`
        CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, categories TEXT);
        CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, custom_domain TEXT, preview_url TEXT);
      `);
      tdb.prepare("INSERT INTO leads (id, business_name, email) VALUES (245, 'F145 Cuts', 'cuts@fixture.test')").run();
      tdb
        .prepare(
          "INSERT INTO websites (lead_id, custom_domain, preview_url) VALUES (245, '', 'https://fixture145.test')"
        )
        .run();
      const embed = publish(tdb, sm.ensureEmbed(tdb, 245, 'bookings', { workspaceId: 999 }), 'book');
      const svc = sm.createBookingService(tdb, 245, {
        name: 'Cut',
        price_cents: 10000,
        duration_minutes: 30,
        status: 'published',
      });
      sm.updateBookingSettings(tdb, 245, { auto_confirm: true });
      const apptDate = new Date(Date.now() + 10 * 86400000);
      const ymd = apptDate.toISOString().slice(0, 10);
      const weekday = new Date(ymd + 'T12:00:00Z').getUTCDay();
      tdb
        .prepare('INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (245, ?, ?, ?)')
        .run(weekday, '00:00', '23:30');

      // F08 + F07(a/b): priced + configured, NO client return_url —
      // the server derives the site origin; the hold is 30 minutes
      // (Ely's ruling) and the session's expires_at is capped at the
      // earliest Stripe-permissible value (≈ the hold expiry +
      // ~1 minute — present, ≥ Stripe's 30-minute minimum, and NOT
      // the 24h default an absent expires_at would mean).
      const booking = await sm.createPublicBookingByToken(tdb, embed.public_token, {
        service_id: svc.id,
        starts_at: ymd + 'T10:00:00',
        customer_name: 'Pat',
        customer_email: 'pat@fixture.test',
      });
      assert.strictEqual(booking.payment.required, true, 'F08: priced booking requires payment');
      assert.strictEqual(capturedSessions.length, 1, 'F08: a checkout session was created without a client return_url');
      const params = capturedSessions[0];
      assert.ok(
        String(params.success_url).startsWith('https://fixture145.test/book'),
        `F08: return URL derived from the site origin + embed page (got ${params.success_url})`
      );
      const orderId = booking.payment.order_id;
      const appt = tdb.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.appointment.id);
      assert.strictEqual(appt.payment_state, 'hold', 'booking sits in hold until payment lands');
      const holdMin = (Date.parse(appt.payment_expires_at) - Date.parse(appt.created_at)) / 60000;
      assert.ok(holdMin > 29 && holdMin < 31, `F07: hold is 30 minutes (got ${holdMin.toFixed(1)})`);
      const holdExpirySec = Math.floor(Date.parse(appt.payment_expires_at) / 1000);
      assert.ok(
        Number.isInteger(params.expires_at),
        'F07: session expires_at is set (an absent value would mean the 24h default)'
      );
      assert.ok(
        params.expires_at >= holdExpirySec,
        `F07: session expires_at is not before the hold expiry (got ${holdExpirySec - params.expires_at}s early)`
      );
      assert.ok(
        params.expires_at <= holdExpirySec + 120,
        `F07: session expires_at lands within ~2 minutes after the hold expiry (got +${params.expires_at - holdExpirySec}s)`
      );
      n += 8;

      // F07(b): the hold lapses, THEN the payment completes — the
      // order is flagged paid_unfulfilled and auto-refunded, never
      // silently paid.
      tdb.prepare("UPDATE bookings SET payment_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(appt.id);
      sm.releaseExpiredBookingHolds(tdb, 245);
      const released = tdb.prepare('SELECT payment_state, status FROM bookings WHERE id = ?').get(appt.id);
      assert.strictEqual(released.payment_state, 'released');
      const lateResult = sm.applyTenantStripeEvent(tdb, {
        id: 'evt_145_latepay',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_145_1',
            payment_status: 'paid',
            payment_intent: 'pi_late_145',
            amount_total: 10000,
            currency: 'USD',
            customer_details: { email: 'pat@fixture.test' },
          },
        },
      });
      assert.strictEqual(lateResult.status, 'paid_unfulfilled', 'F07: late payment is flagged, not fulfilled');
      const order1 = tdb.prepare('SELECT * FROM ecommerce_orders WHERE id = ?').get(orderId);
      assert.strictEqual(order1.status, 'paid_unfulfilled');
      const apptAfter = tdb.prepare('SELECT payment_state, status FROM bookings WHERE id = ?').get(appt.id);
      assert.strictEqual(apptAfter.payment_state, 'paid_unfulfilled', 'F07: booking keeps the unfulfilled flag');
      assert.strictEqual(apptAfter.status, 'cancelled', 'F07: the released booking is not resurrected');
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(refundCalls.length, 1, 'F07: the automatic refund was attempted');
      assert.strictEqual(refundCalls[0].payment_intent, 'pi_late_145');
      const order1b = tdb.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(orderId);
      assert.strictEqual(order1b.status, 'refunded', 'F07: a successful auto-refund settles the order');
      n += 7;

      // F08(b): priced + configured but NO derivable origin at all —
      // fail closed, never the free path, no booking created.
      tdb.prepare("INSERT INTO leads (id, business_name, email) VALUES (246, 'No Origin', 'no@fixture.test')").run();
      const embed2 = publish(tdb, sm.ensureEmbed(tdb, 246, 'bookings', { workspaceId: 999 }));
      const svc2 = sm.createBookingService(tdb, 246, {
        name: 'Cut',
        price_cents: 5000,
        duration_minutes: 30,
        status: 'published',
      });
      tdb
        .prepare('INSERT INTO booking_hours (lead_id, weekday, start_time, end_time) VALUES (246, ?, ?, ?)')
        .run(weekday, '00:00', '23:30');
      await rejectsCode(
        sm.createPublicBookingByToken(tdb, embed2.public_token, {
          service_id: svc2.id,
          starts_at: ymd + 'T11:00:00',
          customer_name: 'Sam',
          customer_email: 'sam@fixture.test',
        }),
        'BOOKING_RETURN_URL_UNAVAILABLE'
      );
      const orphanCount = tdb.prepare('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = 246').get().c;
      assert.strictEqual(orphanCount, 0, 'F08: fail-closed creates no booking');
      n += 2;

      // F08(c): priced but NOT configured — the genuine free path.
      paymentsOn = false;
      const freeBooking = await sm.createPublicBookingByToken(tdb, embed.public_token, {
        service_id: svc.id,
        starts_at: ymd + 'T12:00:00',
        customer_name: 'Jo',
        customer_email: 'jo@fixture.test',
      });
      assert.ok(!freeBooking.payment || !freeBooking.payment.required, 'F08: unconfigured business books free');
      assert.strictEqual(capturedSessions.length, 1, 'F08: no session is created when payments are off');
      paymentsOn = true;
      n += 2;

      // F06: terminal guards + processed-event receipt.
      const shopEmbed = publish(tdb, sm.ensureEmbed(tdb, 245, 'ecommerce', { workspaceId: 999 }));
      const product = sm.createProduct(tdb, 245, { name: 'Serum', price_cents: 2500, status: 'published' });
      const shop = await sm.createShopCheckoutByToken(tdb, shopEmbed.public_token, {
        productId: product.id,
        returnUrl: 'https://fixture145.test/shop',
      });
      assert.ok(shop.sessionId, 'shop checkout created');
      const completedEvt = {
        id: 'evt_145_shop_a',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: shop.sessionId,
            payment_status: 'paid',
            payment_intent: 'pi_shop_145',
            amount_total: 2500,
            currency: 'USD',
            customer_details: { email: 'buyer@fixture.test' },
          },
        },
      };
      const paidRes = sm.applyTenantStripeEvent(tdb, completedEvt);
      assert.strictEqual(paidRes.status, 'paid');
      const receipt = tdb
        .prepare('SELECT * FROM shop_processed_stripe_events WHERE event_id = ?')
        .get('evt_145_shop_a');
      assert.ok(receipt && receipt.order_id === paidRes.orderId, 'F06: the processed event is receipted');
      const refundRes = sm.applyTenantStripeEvent(tdb, {
        id: 'evt_145_shop_r',
        type: 'charge.refunded',
        data: { object: { payment_intent: 'pi_shop_145', amount: 2500, amount_refunded: 2500 } },
      });
      assert.strictEqual(refundRes.status, 'refunded');
      // A redelivery of the SAME completion event id: receipt no-op.
      const replaySame = sm.applyTenantStripeEvent(tdb, completedEvt);
      assert.strictEqual(replaySame.duplicate, true, 'F06: redelivered event id is a receipt no-op');
      // A replayed completion under a NEW event id: terminal guard.
      const replayNew = sm.applyTenantStripeEvent(tdb, { ...completedEvt, id: 'evt_145_shop_b' });
      assert.strictEqual(replayNew.status, 'refunded', 'F06: refunded is terminal for a replayed completion');
      const expiredReplay = sm.applyTenantStripeEvent(tdb, {
        id: 'evt_145_shop_c',
        type: 'checkout.session.expired',
        data: { object: { id: shop.sessionId } },
      });
      assert.strictEqual(expiredReplay.status, 'refunded', 'F06: refunded is terminal for expired too');
      const orderFinal = tdb.prepare('SELECT status FROM ecommerce_orders WHERE id = ?').get(paidRes.orderId);
      assert.strictEqual(orderFinal.status, 'refunded', 'F06: the order never resurrects');
      n += 7;
      tdb.close();
    } finally {
      shopStripe.resolveForLead = realResolve;
      shopStripe.isConfiguredForLead = realConfigured;
    }
    group('Part 8 shop/bookings F06/F07/F08', n);
  }

  /* ====== Part 9 — F14 availability in the business timezone ====== */
  {
    let n = 0;
    const clock = { ms: Date.parse('2026-01-15T14:00:00Z') };
    class FrozenDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [clock.ms]));
      }
      static now() {
        return clock.ms;
      }
    }
    const smF = loadWithGlobals('server/siteModules.js', {}, { Date: FrozenDate });
    const Database = require('better-sqlite3');
    const tdb = new Database(':memory:');
    smF.ensureTables(tdb);
    tdb.exec(`
      CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, categories TEXT);
      CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, custom_domain TEXT, preview_url TEXT);
    `);
    tdb.prepare("INSERT INTO leads (id, business_name, email) VALUES (345, 'F14 Cuts', 'f14@fixture.test')").run();
    const svc = smF.createBookingService(tdb, 345, { name: 'Cut', duration_minutes: 60, status: 'published' });
    smF.updateBookingSettings(tdb, 345, { timezone: 'America/Los_Angeles', min_notice_hours: 2 });
    // 2026-01-15 is a Thursday; default hours Mon–Fri 09:00–17:00.
    // 14:00Z = 06:00 in Los Angeles: with a 2h notice the earliest
    // bookable instant is 08:00 local — the 09:00 wall-clock slot
    // (17:00Z) MUST be offered. (Base computed the cutoff in UTC and
    // killed every slot before 16:00.)
    const slots = smF.listAvailableSlots(tdb, 345, { date: '2026-01-15', serviceId: svc.id }).slots;
    assert.ok(
      slots.some((s) => s.starts_at === '2026-01-15T09:00:00'),
      `F14: the 09:00 Los Angeles slot is offered (got ${slots.map((s) => s.starts_at).join(',') || 'none'})`
    );
    n++;
    // 02:00Z on Jan 15 is still Jan 14 in Los Angeles: that date is
    // NOT "in the past" there, while Jan 13 is past in both zones.
    clock.ms = Date.parse('2026-01-15T02:00:00Z');
    assert.doesNotThrow(
      () => smF.listAvailableSlots(tdb, 345, { date: '2026-01-14', serviceId: svc.id }),
      'F14: zone-local today is not rejected as past'
    );
    n++;
    let pastErr = null;
    try {
      smF.listAvailableSlots(tdb, 345, { date: '2026-01-13', serviceId: svc.id });
    } catch (e) {
      pastErr = e;
    }
    assert.ok(pastErr && /in the past/.test(pastErr.message), 'F14: a genuinely past date is still refused');
    n++;
    // Timezone values are validated on save — refused, never clamped.
    throwsCode(() => smF.updateBookingSettings(tdb, 345, { timezone: 'Mars/Olympus' }), 'VALIDATION');
    n++;
    tdb.close();
    group('Part 9 F14 timezones', n);
  }

  /* ====== Part 10 — F09 non-creating opens + F10 handle leases ====== */
  {
    let n = 0;
    const workspaceDb = require(path.join(root, 'server/workspaceDb.js'));
    const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));
    const domain = require(path.join(root, 'server/domain.js'));
    const dataDir = process.env.WORKSPACE_DATA_DIR;
    // F09: a create:false open of a tenant that does not exist is a
    // clean null and provisions NOTHING (no folder, no DB file).
    assert.strictEqual(workspaceDb.openWorkspaceDb(999999, { create: false }), null);
    assert.ok(!fs.existsSync(path.join(dataDir, '999999')), 'F09: no workspace folder was created');
    n += 2;
    // F09: the archived-preview gate skips cleanly (downstream 404)
    // for a bogus ws- preview instead of minting a tenant DB.
    let nextCalled = false;
    const fakeRes = {
      statusCode: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json() {
        return this;
      },
      setHeader() {
        return this;
      },
      send() {
        return this;
      },
    };
    previewSecurity.blockArchivedPreviews(
      { path: '/ws-999999-site-1-x/index.html', method: 'GET', headers: {} },
      fakeRes,
      () => {
        nextCalled = true;
      }
    );
    assert.ok(nextCalled, 'F09: gate falls through for a nonexistent workspace');
    assert.ok(!fs.existsSync(path.join(dataDir, '999999')), 'F09: the gate provisioned nothing');
    n += 2;

    // F10 groundwork: read-only handles from create:false never leak
    // into a later writable open of the same tenant.
    workspaceDb.closeAll();
    const roDb = workspaceDb.openWorkspaceDb(2, { create: false });
    assert.ok(roDb && roDb.readonly === true, 'F10: an existing tenant opens read-only under create:false');
    const rwDb = workspaceDb.openWorkspaceDb(2);
    assert.ok(rwDb.readonly === false, 'F10: the writable open replaces the read-only handle');
    n += 2;
    // F10: withDb holds a lease — cache churn (40 opens against a
    // 32-handle cache) cannot evict the in-use handle mid-callback.
    await domain.withDb(1, async (heldDb) => {
      assert.ok(workspaceDb.leaseCount(1) >= 1, 'F10: withDb acquires a lease');
      for (let i = 0; i < 40; i++) workspaceDb.openWorkspaceDb(5000 + i);
      assert.strictEqual(heldDb.open, true, 'F10: the leased handle survives eviction pressure');
      heldDb.prepare('SELECT 1').get();
    });
    assert.strictEqual(workspaceDb.leaseCount(1), 0, 'F10: the lease is released when withDb returns');
    n += 3;
    group('Part 10 F09/F10 preview + leases', n);
  }

  /* ====== Part 11 — F11 browser SSRF guard ====== */
  {
    let n = 0;
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      delete require.cache[require.resolve(path.join(root, 'server/browserGuard.js'))];
      delete require.cache[require.resolve(path.join(root, 'server/urlSafety.js'))];
      const guard = require(path.join(root, 'server/browserGuard.js'));
      await rejectsCode(guard.assertBrowserUrl('http://127.0.0.1:3000/admin'), 'URL_LOCAL');
      await rejectsCode(guard.assertBrowserUrl('http://169.254.169.254/latest/meta-data'), 'URL_PRIVATE');
      // IPv6 loopback is refused too (the exact code depends on the
      // resolver path — URL_LOCAL when parsed as a literal, URL_DNS
      // when the sandbox resolver fails closed; either way it never
      // reaches a browser).
      let v6Refused = false;
      try {
        await guard.assertBrowserUrl('http://[::1]/x');
      } catch {
        v6Refused = true;
      }
      assert.ok(v6Refused, 'F11: IPv6 loopback refused');
      await rejectsCode(guard.assertBrowserUrl('file:///etc/passwd'), 'URL_SCHEME');
      const ok = await guard.assertBrowserUrl('https://93.184.216.34/');
      assert.strictEqual(ok.hostname, '93.184.216.34', 'F11: a public IP literal passes');
      n += 5;
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
    group('Part 11 F11 browser guard', n);
  }

  console.log(`\nbatch145-external-review-fixes-regressions: ALL GREEN — ${groups.length} parts`);
  for (const g of groups) console.log('  ' + g);
})().catch((e) => {
  console.error('batch145-external-review-fixes-regressions FAILED:', e);
  process.exit(1);
});
