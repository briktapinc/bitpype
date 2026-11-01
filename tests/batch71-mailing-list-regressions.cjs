'use strict';
/**
 * Batch 71 — Admin-only Mailing List + Newsletter (BitPype's OWN list).
 *
 * Ely's ask (2026-10-29, corrected scope): "a mailing list to manage
 * and a newsletter to send messages to the mailing list" — for HIM,
 * Admin only. No client module, no portal panel, no per-workspace
 * lists, no seeding from leads.
 *
 * What is pinned here:
 *   - Subscribers live at platform level (mailing_list_subscribers),
 *     populated only through the admin surface: add validates +
 *     normalizes, duplicates report as duplicates, and an unsubscribed
 *     address is NEVER silently flipped back — add/import report it
 *     as blocked and only the explicit re-subscribe action restores it.
 *   - Import (paste / CSV) reports exact added / duplicate / blocked /
 *     invalid counts, skips a CSV header row.
 *   - List search + pagination are real (no silent 50-cap).
 *   - Unsubscribe tokens are HMAC-signed (outreach interest-link
 *     family): a good token flips the subscriber, a forged/tampered
 *     one is rejected, re-clicking is idempotent.
 *   - Placeholders: {{name}} / {{email}} / {{unsubscribe_url}}
 *     substitute; unknown placeholders render literally.
 *   - Preview-before-send is a hard gate (a changed subject/body after
 *     preview is refused), the send requires the EXACT eligible
 *     recipient count, unsubscribed + suppression-listed addresses are
 *     never mailed, one recipient's failure does not abort the rest,
 *     and every send lands in mailing_list_sends with honest totals.
 *   - HTTP: the admin endpoints reject anonymous (401) and non-super
 *     staff (403); the public unsubscribe GET works without a session;
 *     an unconfigured mailer over HTTP reports failed sends honestly
 *     (never a fake success) and the send is audit-logged.
 *
 * Harness: in-process engine checks on a temp sqlite platform DB +
 * HTTP tests against the real server booted on temp DBs (batch66/70
 * pattern). No live server, no real mail.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b71-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch71', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 12).toString('base64');

const PORT = 31471;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch71', 'fixture', 'password'].join('-');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

/* ==================================================================== */
/* Part A — engine level (in-process, temp platform DB)                  */
/* ==================================================================== */

async function partA() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const ml = require(path.join(root, 'server/mailingList.js'));
  const q = platformDb.query;

  await checkAsync('tables: mailing list tables exist at platform level after migrate', async () => {
    const names = await require('./lib/platformTestDb.cjs').platformTablesLike(platformDb, 'mailing_list%');
    assert.deepEqual(names, ['mailing_list_sends', 'mailing_list_subscribers']);
  });

  await checkAsync('add: validates, normalizes case/space, stores name + source', async () => {
    const r = await ml.addSubscriber({ name: '  Ada   Lovelace ', email: '  ADA@Example.COM ' });
    assert.equal(r.added, true);
    assert.equal(r.subscriber.email, 'ada@example.com');
    assert.equal(r.subscriber.name, 'Ada Lovelace');
    assert.equal(r.subscriber.status, 'subscribed');
    await assert.rejects(() => ml.addSubscriber({ email: 'not-an-email' }), (e) => e.code === 'VALIDATION');
    await assert.rejects(() => ml.addSubscriber({ email: '' }), (e) => e.code === 'VALIDATION');
    await assert.rejects(() => ml.addSubscriber({}), (e) => e.code === 'VALIDATION');
  });

  await checkAsync('add duplicate: reported, not duplicated, existing name untouched', async () => {
    const r = await ml.addSubscriber({ name: 'Other Name', email: 'ada@example.com' });
    assert.equal(r.added, false);
    assert.equal(r.reason, 'duplicate');
    assert.equal(r.subscriber.name, 'Ada Lovelace');
    const list = await ml.listSubscribers({ search: 'ada@' });
    assert.equal(list.total, 1);
  });

  await checkAsync('import: paste + CSV counts are exact (added/dup/blocked/invalid, header skipped)', async () => {
    const text = [
      'email,name',
      'grace@example.com, Grace Hopper',
      'alan@example.com',
      'ada@example.com, Duplicate Ada',
      'not an email',
      'marie@example.com,Marie Curie',
      'grace@example.com, Grace Again',
    ].join('\n');
    const out = await ml.importSubscribers(text);
    assert.equal(out.added, 3, JSON.stringify(out));
    assert.equal(out.duplicates, 2, JSON.stringify(out));
    assert.equal(out.blockedUnsubscribed, 0);
    assert.deepEqual(out.invalid, ['not an email']);
    await assert.rejects(() => ml.importSubscribers('   '), (e) => e.code === 'VALIDATION');
  });

  let adaId;
  await checkAsync('unsubscribe flip: status + timestamp set; re-add is BLOCKED until explicit re-subscribe', async () => {
    const list = await ml.listSubscribers({ search: 'ada@' });
    adaId = list.rows[0].id;
    const un = await ml.setSubscriberStatus(adaId, 'unsubscribed');
    assert.equal(un.status, 'unsubscribed');
    assert.ok(un.unsubscribed_at, 'unsubscribed_at stamped');
    const blocked = await ml.addSubscriber({ email: 'ada@example.com' });
    assert.equal(blocked.added, false);
    assert.equal(blocked.reason, 'unsubscribed');
    const still = await ml.getSubscriberById(adaId);
    assert.equal(still.status, 'unsubscribed', 'no silent flip from add');
    const imp = await ml.importSubscribers('ada@example.com');
    assert.equal(imp.blockedUnsubscribed, 1);
    assert.equal(imp.added, 0);
    const re = await ml.setSubscriberStatus(adaId, 'subscribed');
    assert.equal(re.status, 'subscribed');
    assert.equal(re.unsubscribed_at, null);
  });

  await checkAsync('token: sign/verify round-trip; forged + tampered + wrong-shape rejected', async () => {
    const token = ml.signUnsubscribeToken(adaId);
    assert.deepEqual(ml.verifyUnsubscribeToken(token), { subscriberId: adaId });
    const [body, sig] = token.split('.');
    assert.throws(() => ml.verifyUnsubscribeToken(`${body}.${sig.slice(0, -2)}xx`), (e) => e.code === 'INVALID_TOKEN');
    const forgedBody = Buffer.from(JSON.stringify({ s: 999999, a: 'ml-unsub', v: 1 })).toString('base64url');
    assert.throws(() => ml.verifyUnsubscribeToken(`${forgedBody}.${sig}`), (e) => e.code === 'INVALID_TOKEN');
    assert.throws(() => ml.verifyUnsubscribeToken('garbage'), (e) => e.code === 'INVALID_TOKEN');
    assert.throws(() => ml.verifyUnsubscribeToken(''), (e) => e.code === 'INVALID_TOKEN');
  });

  await checkAsync('applyUnsubscribe: flips once, idempotent after, bad token is a clean refusal', async () => {
    const token = ml.signUnsubscribeToken(adaId);
    const first = await ml.applyUnsubscribe(token);
    assert.equal(first.ok, true);
    assert.equal(first.already, false);
    const second = await ml.applyUnsubscribe(token);
    assert.equal(second.ok, true);
    assert.equal(second.already, true);
    const bad = await ml.applyUnsubscribe('nope.nope');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_TOKEN');
    // restore for later checks
    await ml.setSubscriberStatus(adaId, 'subscribed');
  });

  await checkAsync('pagination + search: 60 more subscribers page correctly, no 50-cap', async () => {
    const lines = [];
    for (let i = 1; i <= 60; i++) lines.push(`user${String(i).padStart(2, '0')}@bulk.example`);
    const out = await ml.importSubscribers(lines.join('\n'));
    assert.equal(out.added, 60);
    const p1 = await ml.listSubscribers({ search: 'bulk.example', page: 1, pageSize: 50 });
    assert.equal(p1.total, 60);
    assert.equal(p1.rows.length, 50);
    const p2 = await ml.listSubscribers({ search: 'bulk.example', page: 2, pageSize: 50 });
    assert.equal(p2.rows.length, 10);
    assert.notEqual(p1.rows[0].id, p2.rows[0].id);
    const counts = (await ml.listSubscribers({})).counts;
    assert.equal(counts.total, 64);
    assert.equal(counts.subscribed, 64);
    assert.equal(counts.unsubscribed, 0);
  });

  check('substitute: known placeholders fill, unknown stay literal', () => {
    const out = ml.substitute('Hi {{name}} <{{email}}> {{bogus}} {{ unsubscribe_url }}', {
      name: 'Ada',
      email: 'ada@example.com',
    }, 'https://x.test/u');
    assert.equal(out, 'Hi Ada <ada@example.com> {{bogus}} https://x.test/u');
  });

  check('render: per-recipient subject/body + signed unsubscribe footer in html and text', () => {
    const mail = ml.renderNewsletter(
      { subject: 'News for {{name}}', bodyHtml: '<p>Hello {{name}} ({{email}})</p>' },
      { id: adaId, name: 'Ada Lovelace', email: 'ada@example.com' }
    );
    assert.equal(mail.subject, 'News for Ada Lovelace');
    assert.ok(mail.html.includes('Hello Ada Lovelace (ada@example.com)'));
    assert.ok(mail.html.includes('/api/v1/mailing-list/unsubscribe/'), 'unsubscribe link in html');
    assert.ok(mail.text.includes('Unsubscribe: http'), 'unsubscribe link in text');
    assert.throws(
      () => ml.renderNewsletter({ subject: 'x', bodyHtml: '<script>alert(1)</script>' }, { id: adaId, email: 'a@b.co' }),
      (e) => e.code === 'VALIDATION'
    );
  });

  await checkAsync('send gate: no preview → PREVIEW_REQUIRED; changed body → PREVIEW_REQUIRED', async () => {
    const deps = { sendMail: async () => {}, isSuppressed: () => false };
    await assert.rejects(
      () => ml.sendNewsletter({ subject: 'S', bodyHtml: '<p>x</p>', confirmCount: 64 }, deps),
      (e) => e.code === 'PREVIEW_REQUIRED'
    );
    const pv = await ml.previewNewsletter({ subject: 'S', bodyHtml: '<p>x</p>' }, deps);
    await assert.rejects(
      () =>
        ml.sendNewsletter(
          { subject: 'S', bodyHtml: '<p>CHANGED</p>', previewToken: pv.previewToken, confirmCount: pv.recipientCount },
          deps
        ),
      (e) => e.code === 'PREVIEW_REQUIRED'
    );
  });

  await checkAsync('send: exact-count confirm enforced; wrong count refused with the real count', async () => {
    const deps = { sendMail: async () => {}, isSuppressed: () => false };
    const pv = await ml.previewNewsletter({ subject: 'Counted', bodyHtml: '<p>hi</p>' }, deps);
    assert.equal(pv.recipientCount, 64);
    await assert.rejects(
      () => ml.sendNewsletter({ subject: 'Counted', bodyHtml: '<p>hi</p>', previewToken: pv.previewToken, confirmCount: 3 }, deps),
      (e) => e.code === 'CONFIRM_MISMATCH' && /64/.test(e.message)
    );
  });

  await checkAsync('send: subscribed-only + suppression honored, failure isolated, history logged honestly', async () => {
    // One unsubscribed (never mailed), one suppressed (skipped).
    const unsub = await ml.addSubscriber({ email: 'gone@example.com', name: 'Gone' });
    await ml.setSubscriberStatus(unsub.subscriber.id, 'unsubscribed');
    const mailed = [];
    const deps = {
      sendMail: async (m) => {
        if (m.to === 'user07@bulk.example') throw new Error('mailbox full');
        mailed.push(m.to);
      },
      isSuppressed: (email) => email === 'marie@example.com',
    };
    const pv = await ml.previewNewsletter({ subject: 'October news', bodyHtml: '<p>Hi {{name}}</p>' }, deps);
    assert.equal(pv.subscribedCount, 64, 'gone@ is unsubscribed and never counted; marie is subscribed but suppressed');
    assert.equal(pv.suppressedCount, 1);
    assert.equal(pv.recipientCount, 63);
    const out = await ml.sendNewsletter(
      { subject: 'October news', bodyHtml: '<p>Hi {{name}}</p>', previewToken: pv.previewToken, confirmCount: 63, createdBy: 1 },
      deps
    );
    assert.equal(out.attempted, 63);
    assert.equal(out.sent, 62);
    assert.equal(out.failed, 1);
    assert.equal(out.skippedSuppressed, 1);
    assert.ok(!mailed.includes('gone@example.com'), 'unsubscribed never mailed');
    assert.ok(!mailed.includes('marie@example.com'), 'suppressed never mailed');
    assert.ok(!mailed.includes('user07@bulk.example'), 'failed recipient not in sent set');
    const history = await ml.listSends({});
    const row = history.rows.find((r) => r.id === out.sendId);
    assert.ok(row, 'history row exists');
    assert.equal(row.subject, 'October news');
    assert.equal(row.attempted, 63);
    assert.equal(row.sent, 62);
    assert.equal(row.failed, 1);
    assert.equal(row.skipped, 1);
  });

  await checkAsync('remove: hard delete removes the row; unknown ids are coded NOT_FOUND', async () => {
    const tmp = await ml.addSubscriber({ email: 'temp@example.com' });
    const out = await ml.removeSubscriber(tmp.subscriber.id);
    assert.equal(out.removed, true);
    assert.equal(await ml.getSubscriberById(tmp.subscriber.id), null);
    await assert.rejects(() => ml.removeSubscriber(999999), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(() => ml.setSubscriberStatus(999999, 'unsubscribed'), (e) => e.code === 'NOT_FOUND');
  });

  await checkAsync('default suppression path: missing workspace suppression table degrades to not-suppressed', async () => {
    const { eligible } = await ml.eligibleRecipients({});
    assert.ok(Array.isArray(eligible));
  });

  return { ml };
}

/* ==================================================================== */
/* Part B — HTTP: staff gating, public unsubscribe, honest send          */
/* ==================================================================== */

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function partB({ ml }) {
  const platformDb = require(path.join(root, 'server/db.js'));
  const q = platformDb.query;
  const workspace = require(path.join(root, 'server/workspace.js'));
  const totp = require(path.join(root, 'src/totp.js'));

  await workspace.createUserWithWorkspace({
    email: 'owner71@example.invalid',
    password: PW,
    name: 'Owner71',
    workspaceName: 'Batch71 WS',
  });
  await q('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'owner71@example.invalid' });
  await workspace.createUserWithWorkspace({
    email: 'member71@example.invalid',
    password: PW,
    name: 'Member71',
    workspaceName: 'Batch71 Member WS',
  });

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

    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (jar, p) => jar.fetch(BASE + p, { method: 'GET' });
    async function staffSession(email) {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email, password: PW });
      let body = await json(res);
      assert(res.status === 200 && body.data && body.data.mfaRequired === true, `login challenge for ${email}: ${JSON.stringify(body)}`);
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data && body.data.secret;
      assert(secret, 'enroll start returns a secret');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data && body.data.user, `session for ${email}`);
      return jar;
    }

    await checkAsync('HTTP gate: anonymous is refused the admin mailing list (401)', async () => {
      const res = await fetch(`${BASE}/api/v1/admin/mailing-list/subscribers`);
      assert.equal(res.status, 401);
    });

    const memberJar = await staffSession('member71@example.invalid');
    await checkAsync('HTTP gate: non-super staff session is refused (403)', async () => {
      const res = await get(memberJar, '/api/v1/admin/mailing-list/subscribers');
      assert.equal(res.status, 403);
      const res2 = await post(memberJar, '/api/v1/admin/mailing-list/subscribers', { email: 'x@example.com' });
      assert.equal(res2.status, 403);
    });

    const adminJar = await staffSession('owner71@example.invalid');
    let httpSubId;
    await checkAsync('HTTP: super admin adds a subscriber and sees counts', async () => {
      const res = await post(adminJar, '/api/v1/admin/mailing-list/subscribers', {
        name: 'Http Sub',
        email: 'http-sub@example.com',
      });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.added, true);
      httpSubId = body.data.subscriber.id;
      const list = await json(await get(adminJar, '/api/v1/admin/mailing-list/subscribers?search=http-sub'));
      assert.equal(list.data.total, 1);
      assert.equal(list.data.counts.subscribed, 65, 'part A subscribed (64) + this one');
    });

    await checkAsync('HTTP: public unsubscribe link flips the subscriber without any session', async () => {
      const token = ml.signUnsubscribeToken(httpSubId);
      const res = await fetch(`${BASE}/api/v1/mailing-list/unsubscribe/${token}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(/unsubscribed/i.test(html), 'confirmation page says unsubscribed');
      const list = await json(await get(adminJar, '/api/v1/admin/mailing-list/subscribers?search=http-sub'));
      assert.equal(list.data.rows[0].status, 'unsubscribed');
      const bad = await fetch(`${BASE}/api/v1/mailing-list/unsubscribe/forged.token`);
      assert.equal(bad.status, 400);
    });

    await checkAsync('HTTP: send with unconfigured mail reports failure honestly + audit row written', async () => {
      // Re-subscribe so there is exactly ≥1 eligible recipient.
      await post(adminJar, `/api/v1/admin/mailing-list/subscribers/${httpSubId}/resubscribe`, {});
      const pv = await json(
        await post(adminJar, '/api/v1/admin/mailing-list/preview', { subject: 'HTTP news', bodyHtml: '<p>Hello</p>' })
      );
      assert.ok(pv.data.previewToken, 'preview token issued');
      assert.ok(pv.data.recipientCount >= 1, 'recipients counted');
      const send = await json(
        await post(adminJar, '/api/v1/admin/mailing-list/send', {
          subject: 'HTTP news',
          bodyHtml: '<p>Hello</p>',
          previewToken: pv.data.previewToken,
          confirmCount: pv.data.recipientCount,
        })
      );
      assert.equal(send.data.attempted, pv.data.recipientCount);
      assert.equal(send.data.sent, 0, 'no fake success — mail is not configured in this fixture');
      assert.equal(send.data.failed, pv.data.recipientCount);
      const sends = await json(await get(adminJar, '/api/v1/admin/mailing-list/sends'));
      assert.ok(sends.data.rows.some((r) => r.subject === 'HTTP news' && r.failed === pv.data.recipientCount), 'send history carries the honest totals');
      const audit = await q("SELECT * FROM platform_audit WHERE action = 'mailing_list.send'");
      assert.ok(audit.length >= 1, 'mailing_list.send audit row exists');
    });

    await checkAsync('HTTP: send without preview is refused (400 PREVIEW_REQUIRED)', async () => {
      const res = await post(adminJar, '/api/v1/admin/mailing-list/send', {
        subject: 'No preview',
        bodyHtml: '<p>x</p>',
        confirmCount: 1,
      });
      const body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(body.code, 'PREVIEW_REQUIRED');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

/* ==================================================================== */

(async () => {
  try {
    const ctx = await partA();
    await partB(ctx);
    console.log(JSON.stringify({ file: 'batch71-mailing-list-regressions', checks: results.length, passed: true }));
    for (const r of results) console.log('  ok -', r);
  } catch (e) {
    console.log(JSON.stringify({ file: 'batch71-mailing-list-regressions', checks: results.length, passed: false }));
    for (const r of results) console.log('  ok -', r);
    console.error('FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
