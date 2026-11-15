'use strict';
/**
 * Batch 191 — MySQL LIKE-escape fix (the Batch 190 gate catch).
 *
 * Root cause: the platform search builders (Batch 180 L13) wrote the
 * LIKE escape as a backslash inside a SQL string literal. The JS
 * source form ESCAPE '\\' produces SQL text holding ONE backslash.
 * MySQL (default sql_mode) parses a backslash inside a string literal
 * as an escape introducer, so the literal is unterminated and the
 * query dies with a syntax error near the closing paren; the doubled
 * form is no rescue — SQLite reads it as a TWO-character string and
 * errors with "ESCAPE expression must be a single character". No
 * backslash literal is valid on both dialects. Batch 191 switches the
 * escape character to '!' (one plain character in both dialects'
 * string literals) and escapes [!%_] in the term by '!'-prefixing.
 *
 * Pinned here — every platform-layer search that carried the pattern
 * executes on BOTH dialects and matches literally:
 *   - mailingList.listSubscribers({search})   (batch71's MySQL failure)
 *   - admin.listUsers({q}) / admin.listWorkspaces({q})
 *   - billing.listPayments({q})
 *   - portalAccounts.listPortalUsers({q})
 * Semantics: %, _ and ! in the term match LITERALLY (never wildcards),
 * a backslash in the term is an ordinary character, and matching is
 * case-insensitive on both dialects (gate MySQL uses the production
 * utf8mb4_unicode_ci collation family; sqlite LIKE is ASCII
 * case-insensitive).
 *
 * NOT touched (proven sqlite-only — they run on per-workspace
 * better-sqlite3 handles and can never reach MySQL, where the
 * single-backslash literal is the correct 1-char SQLite escape):
 * server/domain.js leadsList, server/routes/domainApi.js theme lead
 * search, src/mcp.js lead.search.
 *
 * Harness: in-process engine checks on a temp platform DB (batch71
 * pattern). Under the gate's --mysql pass the runner supplies a fresh
 * MySQL database via REGRESSION_DB_DRIVER + MYSQL_* env; on the
 * Batch 189 tree every check below throws the MySQL syntax error.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b191-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch191', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 12).toString('base64');

const results = [];
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

(async () => {
  try {
    const platformDb = require(path.join(root, 'server/db.js'));
    await platformDb.migrate();
    const q = platformDb.query;
    const ml = require(path.join(root, 'server/mailingList.js'));
    const admin = require(path.join(root, 'server/admin.js'));
    const billing = require(path.join(root, 'server/billing.js'));
    const portalAccounts = require(path.join(root, 'server/portalAccounts.js'));

    /* ------------------------------ seeds ------------------------------ */
    await ml.addSubscriber({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await ml.addSubscriber({ name: '100% Sure', email: 'pct@example.com' });
    await ml.addSubscriber({ name: 'Under_Score', email: 'und@example.com' });
    await ml.addSubscriber({ name: 'Bang! Zoom', email: 'bang@example.com' });

    await q('INSERT INTO users (email, password_hash, name) VALUES (:e, :p, :n)', {
      e: 'ada@example.com',
      p: 'x',
      n: 'Ada Lovelace',
    });
    await q('INSERT INTO users (email, password_hash, name) VALUES (:e, :p, :n)', {
      e: 'pct@example.com',
      p: 'x',
      n: '100% Sure',
    });
    const adaUser = (await q('SELECT id FROM users WHERE email = :e', { e: 'ada@example.com' }))[0];

    await q('INSERT INTO workspaces (name, slug) VALUES (:n, :s)', {
      n: '100% Coverage Co',
      s: 'pct-coverage',
    });
    await q('INSERT INTO workspaces (name, slug) VALUES (:n, :s)', {
      n: 'Back\\Slash Co',
      s: 'backslash-co',
    });

    await q(
      'INSERT INTO payments (user_id, stripe_invoice_id, stripe_charge_id, amount_cents) VALUES (:u, :i, :c, 100)',
      { u: adaUser.id, i: 'in_100%real', c: 'ch_plain' }
    );
    await q(
      'INSERT INTO payments (user_id, stripe_invoice_id, stripe_charge_id, amount_cents) VALUES (:u, :i, :c, 200)',
      { u: adaUser.id, i: 'in_normal', c: 'ch_other' }
    );

    await q(
      'INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name) VALUES (:e, :p, 1, 1, :b)',
      { e: 'ada@client.example', p: 'x', b: 'Ada Cakes' }
    );
    await q(
      'INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name) VALUES (:e, :p, 1, 2, :b)',
      { e: 'pct@client.example', p: 'x', b: '100% Bakery' }
    );

    /* --------------------------- mailing list -------------------------- */
    await checkAsync('mailingList: plain search executes and matches (the batch71 MySQL failure)', async () => {
      const list = await ml.listSubscribers({ search: 'ada@' });
      assert.equal(list.total, 1);
      assert.equal(list.rows[0].email, 'ada@example.com');
    });
    await checkAsync('mailingList: % in the term matches literally, not as a wildcard', async () => {
      const list = await ml.listSubscribers({ search: '100%' });
      assert.equal(list.total, 1);
      assert.equal(list.rows[0].email, 'pct@example.com');
      const bare = await ml.listSubscribers({ search: '%' });
      assert.equal(bare.total, 1);
    });
    await checkAsync('mailingList: _ in the term matches literally, not as a wildcard', async () => {
      const list = await ml.listSubscribers({ search: 'under_score' });
      assert.equal(list.total, 1);
      assert.equal(list.rows[0].email, 'und@example.com');
      const bare = await ml.listSubscribers({ search: '_' });
      assert.equal(bare.total, 1);
    });
    await checkAsync('mailingList: the escape char itself in the term matches literally', async () => {
      const list = await ml.listSubscribers({ search: 'bang!' });
      assert.equal(list.total, 1);
      assert.equal(list.rows[0].email, 'bang@example.com');
    });

    /* ------------------------------ admin ------------------------------ */
    await checkAsync('admin.listUsers: search executes and matches literally', async () => {
      const byEmail = await admin.listUsers({ q: 'ada@' });
      assert.equal(byEmail.length, 1);
      assert.equal(byEmail[0].email, 'ada@example.com');
      const byPct = await admin.listUsers({ q: '100%' });
      assert.equal(byPct.length, 1);
      assert.equal(byPct[0].email, 'pct@example.com');
      const bare = await admin.listUsers({ q: '%' });
      assert.equal(bare.length, 1);
    });
    await checkAsync('admin.listWorkspaces: search executes; % literal; backslash is an ordinary char', async () => {
      const byPct = await admin.listWorkspaces({ q: '100%' });
      assert.equal(byPct.length, 1);
      assert.equal(byPct[0].slug, 'pct-coverage');
      const bySlash = await admin.listWorkspaces({ q: 'back\\slash' });
      assert.equal(bySlash.length, 1);
      assert.equal(bySlash[0].slug, 'backslash-co');
    });

    /* ----------------------------- billing ----------------------------- */
    await checkAsync('billing.listPayments: search executes and matches literally', async () => {
      const byPct = await billing.listPayments({ q: '100%' });
      assert.equal(byPct.length, 1);
      assert.equal(byPct[0].stripe_invoice_id, 'in_100%real');
      const byEmail = await billing.listPayments({ q: 'ada@' });
      assert.equal(byEmail.length, 2);
      const bare = await billing.listPayments({ q: '%' });
      assert.equal(bare.length, 1);
    });

    /* -------------------------- portal accounts ------------------------ */
    await checkAsync('portalAccounts.listPortalUsers: search executes and matches literally', async () => {
      const byPct = await portalAccounts.listPortalUsers({ q: '100%' });
      assert.equal(byPct.users.length, 1);
      assert.equal(byPct.users[0].email, 'pct@client.example');
      const byEmail = await portalAccounts.listPortalUsers({ q: 'ada@' });
      assert.equal(byEmail.users.length, 1);
      assert.equal(byEmail.users[0].email, 'ada@client.example');
      const bare = await portalAccounts.listPortalUsers({ q: '%' });
      assert.equal(bare.users.length, 1);
    });

    console.log(
      JSON.stringify({
        file: 'batch191-mysql-like-escape-regressions',
        checks: results.length,
        passed: true,
        driver: process.env.DB_DRIVER,
      })
    );
    for (const r of results) console.log('  ok -', r);
  } catch (e) {
    console.log(
      JSON.stringify({
        file: 'batch191-mysql-like-escape-regressions',
        checks: results.length,
        passed: false,
        driver: process.env.DB_DRIVER,
      })
    );
    for (const r of results) console.log('  ok -', r);
    console.error('FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
