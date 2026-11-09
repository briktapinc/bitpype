'use strict';
/**
 * Batch 154 — BitPype's own §9 security leftovers (Ely's order
 * 2026-11-06: "Implement the suggestions for Bitpype" — the four
 * controls the SaaS gap audit found BitPype itself only PARTIAL on):
 *
 *   Part 1 — Stripe idempotency helper (server/stripeIdempotency.js):
 *            deterministic (same operation → same key, twice, at
 *            different moments), operation-sensitive, part-sensitive,
 *            bounded shape, no PII-shaped parts in the clear.
 *   Part 2 — Stripe call-site census: EVERY outbound mutating Stripe
 *            call in server/ + src/ carries an idempotency key, and
 *            the headline schemes are pinned (shop checkout by order,
 *            late-paid refund by order, billing checkout by user +
 *            plan, admin refund by payment, membership checkout by
 *            lead + member + tier).
 *   Part 3 — Recovery codes (src/totp.js): new codes are 64-bit
 *            (16 hex, XXXX-XXXX-XXXX-XXXX), hashed-only storage shape
 *            (sha256 of the normalized code), legacy 8-hex codes
 *            still hash (grandfathered until used/regenerated —
 *            the migration rule), junk lengths refuse.
 *   Part 4 — Staff absolute session cap (server/middleware.js):
 *            default 12h, a fresh stamp passes, a stale stamp and a
 *            missing stamp refuse, a portal-shaped session (no
 *            userId) is untouched, and finishStaffLogin is the
 *            stamper (source pin).
 *   Part 5 — Per-account login lockout (server/loginLockout.js)
 *            against a freshly migrated platform DB: threshold 10,
 *            15-minute lock, justLocked fires once, failures while
 *            locked do NOT extend the lock, success resets, staff
 *            and portal surfaces are independent counters.
 *   Part 6 — Portal login integration (server/portalAccounts.js):
 *            wrong passwords feed the lockout; the 10th engages it;
 *            a CORRECT password while locked still fails with the
 *            SAME outward INVALID_CREDENTIALS (detail marker is
 *            server-side only); a success before the threshold
 *            resets the counter.
 *   Part 7 — Wiring pins: staff route checks the lock before the
 *            credential path can complete (no MFA challenge for a
 *            locked account) and answers with the same generic 401;
 *            migrations add the lockout columns on both tables in
 *            both dialects.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'UTC';
process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch154-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.DB_PATH = process.env.PLATFORM_DB_PATH;
process.env.SQLITE_PATH = process.env.PLATFORM_DB_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 43).toString('base64');
process.env.SESSION_SECRET = ['batch154', 'suite', 'secret'].join('-');
process.env.MAIL_DRY_RUN = 'true';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  /* ============ Part 1 — Stripe idempotency helper ============ */
  {
    let n = 0;
    const { stripeIdempotencyKey } = require(path.join(root, 'server/stripeIdempotency.js'));
    const a = stripeIdempotencyKey('checkout-shop', 123, 45);
    const b = stripeIdempotencyKey('checkout-shop', 123, 45);
    assert.equal(a, b, 'same operation + ids → same key (deterministic)');
    n++;
    assert.match(a, /^bp154_checkout-shop_[0-9a-f]{64}$/, 'bounded shape: prefix + op + sha256');
    n++;
    assert.notEqual(stripeIdempotencyKey('checkout-shop', 124, 45), a, 'different business id → different key');
    n++;
    assert.notEqual(stripeIdempotencyKey('refund-admin', 123, 45), a, 'different operation → different key');
    n++;
    assert.equal(stripeIdempotencyKey('checkout-shop', '123', '45'), a, 'string/number id forms derive the same key');
    n++;
    assert.ok(!a.includes('123') && !a.includes('@'), 'no raw ids / PII in the clear');
    n++;
    assert.ok(a.length <= 255, 'within Stripe key length limit');
    n++;
    group('Part 1 stripe idempotency helper', n);
  }

  /* ============ Part 2 — Stripe call-site census ============ */
  {
    let n = 0;
    const mutating = /stripe\.[a-zA-Z.]+\.(create|update|del|delete|cancel)\s*\(/g;
    const files = [];
    for (const dir of ['server', 'src']) {
      for (const f of fs.readdirSync(path.join(root, dir))) {
        if (f.endsWith('.js')) files.push(path.join(dir, f));
      }
    }
    const keyed = {
      'server/billing.js': 15,
      'server/portalBilling.js': 1,
      'server/membershipStripe.js': 3,
      'server/pricingAdmin.js': 3,
      'server/siteModules.js': 3,
      'server/assistantBilling.js': 1,
    };
    let totalCalls = 0;
    for (const rel of files) {
      const src = read(rel);
      const calls = src.match(mutating) || [];
      if (!calls.length) continue;
      totalCalls += calls.length;
      assert.equal(
        calls.length,
        keyed[rel] || 0,
        `${rel}: ${calls.length} mutating Stripe calls — all must be in the keyed census`
      );
      n++;
      const keyCount = (src.match(/idempotencyKey/g) || []).length;
      assert.ok(
        keyCount >= calls.length,
        `${rel}: every mutating call carries an idempotencyKey (${keyCount} keys / ${calls.length} calls)`
      );
      n++;
    }
    assert.equal(totalCalls, 26, 'census total: 26 mutating Stripe call sites (Batch 161 added server/assistantBilling.js: the assistant-usage invoiceItems.create, keyed stripeIdempotencyKey(assistant-usage) — audited, key present in the call)');
    n++;
    // Headline schemes pinned.
    const billing = read('server/billing.js');
    assert.ok(billing.includes("stripeIdempotencyKey('customer-create', user.id)"), 'customer create keyed by user');
    n++;
    assert.ok(billing.includes("'checkout-subscription'"), 'plan checkout scheme present');
    n++;
    assert.ok(
      billing.includes("stripeIdempotencyKey(\n    'refund-admin',") || billing.includes("'refund-admin'"),
      'admin refund scheme present'
    );
    n++;
    const siteModules = read('server/siteModules.js');
    assert.ok(
      siteModules.includes("'checkout-shop', Number(order.id), Number(embedRow.lead_id)"),
      'shop checkout keyed by order + lead (the shared engine — every selling surface)'
    );
    n++;
    assert.ok(
      siteModules.includes("'refund-late-paid-booking', Number(orderId), pi"),
      'late-paid auto-refund keyed by order + payment intent'
    );
    n++;
    assert.ok(siteModules.includes("'checkout-membership'"), 'membership checkout scheme present');
    n++;
    // No PaymentIntent creates exist in the tree (checkout-session
    // only) — pin that so a future PI create must join the census.
    const piCreates = files.filter((rel) => /paymentIntents\.create\s*\(/.test(read(rel)));
    assert.equal(piCreates.length, 0, 'no paymentIntents.create call sites exist to key');
    n++;
    group('Part 2 stripe call-site census', n);
  }

  /* ============ Part 3 — Recovery-code entropy ============ */
  {
    let n = 0;
    const totp = require(path.join(root, 'src/totp.js'));
    assert.equal(totp.RECOVERY_CODE_HEX_LENGTH, 16, 'new recovery codes are 16 hex chars (64-bit)');
    n++;
    const codes = totp.generateRecoveryCodes(10);
    assert.equal(codes.length, 10, 'still 10 codes per enrollment');
    n++;
    assert.ok(
      codes.every((c) => /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(c)),
      'human-typeable XXXX-XXXX-XXXX-XXXX shape'
    );
    n++;
    assert.equal(new Set(codes).size, 10, 'codes are unique within a set');
    n++;
    const normalized = codes[0].replace(/-/g, '');
    assert.equal(normalized.length, 16, 'normalized code carries 64 bits');
    n++;
    assert.equal(
      totp.hashRecoveryCode(codes[0]),
      crypto.createHash('sha256').update(normalized).digest('hex'),
      'only the sha256 of the normalized code is stored'
    );
    n++;
    // Migration rule: legacy 8-hex codes stay valid until used or
    // regenerated — they still hash; anything else refuses.
    assert.equal(
      totp.hashRecoveryCode('ABCD-1234'),
      crypto.createHash('sha256').update('ABCD1234').digest('hex'),
      'legacy 8-hex code still hashes (grandfathered)'
    );
    n++;
    assert.equal(totp.hashRecoveryCode('ABCD-1234-EF01-23'), null, '12-hex junk refuses');
    n++;
    assert.equal(totp.hashRecoveryCode(''), null, 'empty refuses');
    n++;
    assert.equal(
      totp.hashRecoveryCode(codes[1].toLowerCase()),
      totp.hashRecoveryCode(codes[1]),
      'entry is case-insensitive (normalized before hashing)'
    );
    n++;
    group('Part 3 recovery-code entropy', n);
  }

  /* ============ Part 4 — Staff absolute session cap ============ */
  {
    let n = 0;
    const mw = require(path.join(root, 'server/middleware.js'));
    assert.equal(mw.STAFF_ABSOLUTE_SESSION_MS, 12 * 60 * 60 * 1000, 'default cap is 12h');
    n++;
    const now = Date.now();
    assert.equal(mw.staffSessionAbsoluteExpired({ session: null }), false, 'no session → not the cap’s refusal');
    n++;
    assert.equal(
      mw.staffSessionAbsoluteExpired({ session: { clientPortalId: 9 } }),
      false,
      'portal-shaped session (no staff userId) is untouched by the staff cap'
    );
    n++;
    assert.equal(
      mw.staffSessionAbsoluteExpired({ session: { userId: 5, authIssuedAt: now - 60 * 1000 } }),
      false,
      'fresh staff stamp passes'
    );
    n++;
    assert.equal(
      mw.staffSessionAbsoluteExpired({ session: { userId: 5, authIssuedAt: now - 13 * 60 * 60 * 1000 } }),
      true,
      'stamp older than the cap refuses (however active the session)'
    );
    n++;
    assert.equal(
      mw.staffSessionAbsoluteExpired({ session: { userId: 5 } }),
      true,
      'pre-batch session with no stamp is treated as expired (one forced re-login, fail-closed)'
    );
    n++;
    const authSrc = read('server/routes/auth.js');
    assert.ok(
      authSrc.includes('req.session.authIssuedAt = Date.now();'),
      'finishStaffLogin stamps issuance where userId is set'
    );
    n++;
    const mwSrc = read('server/middleware.js');
    assert.ok(mwSrc.includes('STAFF_ABSOLUTE_SESSION_MS'), 'cap is env-overridable via STAFF_ABSOLUTE_SESSION_MS');
    n++;
    group('Part 4 staff absolute session cap', n);
  }

  /* ============ Part 5 — Login lockout (live DB) ============ */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const lockout = require(path.join(root, 'server/loginLockout.js'));
  let staffId;
  let portalId;
  {
    let n = 0;
    assert.equal(lockout.MAX_FAILED_ATTEMPTS, 10, 'threshold is 10 consecutive failures');
    n++;
    assert.equal(lockout.LOCK_MS, 15 * 60 * 1000, 'cooldown is 15 minutes');
    n++;
    await platformDb.query(`INSERT INTO users (email, password_hash, name) VALUES (:email, 'x', 'Batch154 Staff')`, {
      email: 'b154-staff@example.invalid',
    });
    const staffRows = await platformDb.query(`SELECT id FROM users WHERE email = :email`, {
      email: 'b154-staff@example.invalid',
    });
    staffId = Number(staffRows[0].id);
    assert.ok(staffId > 0, 'staff fixture user created');
    n++;
    // Nine failures: no lock. Tenth: lock + justLocked exactly once.
    for (let i = 0; i < 9; i++) {
      const r = await lockout.recordFailure('staff', staffId);
      assert.equal(r.locked, false, `failure ${i + 1} does not lock`);
    }
    n++;
    const tenth = await lockout.recordFailure('staff', staffId);
    assert.deepEqual(tenth, { locked: true, justLocked: true }, '10th failure engages the lock, justLocked fires');
    n++;
    const state = await lockout.getState('staff', staffId);
    assert.equal(state.locked, true, 'state reads locked');
    n++;
    const untilFirst = state.lockedUntil.getTime();
    assert.ok(untilFirst > Date.now() && untilFirst <= Date.now() + lockout.LOCK_MS + 5000, 'lock expires ~15 min out');
    n++;
    const again = await lockout.recordFailure('staff', staffId);
    assert.deepEqual(again, { locked: true, justLocked: false }, 'failure while locked: no re-fire');
    n++;
    const state2 = await lockout.getState('staff', staffId);
    assert.equal(state2.lockedUntil.getTime(), untilFirst, 'failures while locked do NOT extend the lock');
    n++;
    await lockout.recordSuccess('staff', staffId);
    const cleared = await lockout.getState('staff', staffId);
    assert.equal(cleared.locked, false, 'success clears the lock');
    n++;
    const after = await lockout.recordFailure('staff', staffId);
    assert.equal(after.locked, false, 'counter was reset by the success (1 failure ≠ locked)');
    n++;
    // Unknown surface refuses.
    await assert.rejects(() => lockout.getState('nope', staffId), /unknown login-lockout surface/);
    n++;
    group('Part 5 login lockout core', n);
  }

  /* ============ Part 6 — Portal login integration ============ */
  {
    let n = 0;
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('b154-portal-pass', 10);
    await platformDb.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
       VALUES (:email, :hash, 0, 0, 'Batch154 Portal', 'active')`,
      { email: 'b154-portal@example.invalid', hash }
    );
    const rows = await platformDb.query(`SELECT id FROM client_portal_users WHERE email = :email`, {
      email: 'b154-portal@example.invalid',
    });
    portalId = Number(rows[0].id);
    assert.ok(portalId > 0, 'portal fixture user created');
    n++;
    const portalAccounts = require(path.join(root, 'server/portalAccounts.js'));
    // Surfaces are independent: the portal counter starts clean
    // even though the staff surface was exercised above.
    assert.equal((await lockout.getState('portal', portalId)).locked, false, 'portal surface starts unlocked');
    n++;
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        await portalAccounts.login('b154-portal@example.invalid', 'wrong-pass');
        assert.fail('wrong password must throw');
      } catch (e) {
        lastErr = e;
        assert.equal(e.code, 'INVALID_CREDENTIALS', `failure ${i + 1}: outward code stays INVALID_CREDENTIALS`);
      }
    }
    n++;
    assert.equal(lastErr.justLocked, true, 'the 10th failure marks justLocked (server-side only)');
    n++;
    // Correct password while locked: SAME outward error, and the
    // lockout detail marker proves the flow stopped before any
    // MFA stage could be reached.
    let lockedErr = null;
    try {
      await portalAccounts.login('b154-portal@example.invalid', 'b154-portal-pass');
      assert.fail('locked account must not log in');
    } catch (e) {
      lockedErr = e;
    }
    assert.equal(lockedErr.code, 'INVALID_CREDENTIALS', 'locked login is indistinguishable from a bad password');
    n++;
    assert.equal(lockedErr.detail, 'login_locked', 'server-side marker records the lockout stop');
    n++;
    // Reset path: clear the lock, then prove a success resets the
    // counter — 9 failures, a good login (reaches NOT_LINKED, i.e.
    // PAST credential verify, proving verify succeeded), then 9
    // more failures still do not lock.
    await lockout.recordSuccess('portal', portalId);
    for (let i = 0; i < 9; i++) {
      await portalAccounts.login('b154-portal@example.invalid', 'wrong-pass').catch(() => {});
    }
    let verifyErr = null;
    try {
      await portalAccounts.login('b154-portal@example.invalid', 'b154-portal-pass');
    } catch (e) {
      verifyErr = e;
    }
    assert.equal(
      verifyErr && verifyErr.code,
      'NOT_LINKED',
      'correct password passes credential verify (fixture has no site link)'
    );
    n++;
    for (let i = 0; i < 9; i++) {
      await portalAccounts.login('b154-portal@example.invalid', 'wrong-pass').catch(() => {});
    }
    assert.equal(
      (await lockout.getState('portal', portalId)).locked,
      false,
      'success reset the counter — 9 post-success failures do not lock'
    );
    n++;
    group('Part 6 portal login lockout integration', n);
  }

  /* ============ Part 7 — Wiring pins ============ */
  {
    let n = 0;
    const authSrc = read('server/routes/auth.js');
    const lockIdx = authSrc.indexOf("loginLockout.getState('staff'");
    const finishIdx = authSrc.indexOf('finishStaffLogin(req, res, user)');
    assert.ok(lockIdx > 0, 'staff route consults the lockout state');
    n++;
    assert.ok(
      authSrc.includes('lockState.locked') && authSrc.includes("error: 'INVALID_CREDENTIALS'"),
      'staff locked path answers the same generic 401'
    );
    n++;
    assert.ok(finishIdx > lockIdx, 'lockout consult happens in the login handler, before finishStaffLogin can run');
    n++;
    assert.ok(
      authSrc.includes("await loginLockout.recordSuccess('staff', user.id);"),
      'staff success resets the counter'
    );
    n++;
    const dbSrc = read('server/db.js');
    assert.equal(
      (dbSrc.match(/login_failed_attempts/g) || []).length >= 2 ? true : false,
      true,
      'migration adds login_failed_attempts in both dialects'
    );
    n++;
    assert.ok(dbSrc.includes("'login_failed_attempts', 'INTEGER NOT NULL DEFAULT 0'"), 'sqlite columns pinned');
    n++;
    assert.ok(dbSrc.includes("'login_failed_attempts', 'INT NOT NULL DEFAULT 0'"), 'mysql columns pinned');
    n++;
    const portalSrc = read('server/routes/portal.js');
    assert.ok(
      portalSrc.includes("e.justLocked ? 'login_lockout' : 'login_failure'"),
      'portal route raises the lockout auth event'
    );
    n++;
    group('Part 7 wiring pins', n);
  }

  console.log(`\nbatch154-section9-security-regressions: ALL GREEN — ${groups.length} parts`);
  for (const g of groups) console.log('  ' + g);
  await platformDb.close().catch(() => {});
  process.exit(0);
})().catch(async (e) => {
  console.error('batch154-section9-security-regressions FAILED:', e);
  process.exit(1);
});
