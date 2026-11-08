'use strict';
/**
 * Batch 163 — WEBINARS (Ely's order 2026-11-08).
 *
 * Admin (staff, super admin) creates webinars: title, description,
 * scheduled time (entered as Eastern wall time), a YouTube link for
 * the embed, an auto-generated access code and a shareable public
 * link — https://bitpype.com/webinar/<slug>. The link carries NO
 * code: the public gate asks full name + email + phone + code.
 * Passing the gate registers the person (deduped per webinar by
 * email), captures them into LeadScout for workspace 1 via
 * portalContacts.captureFromWebinar with source "Webinar — <title>",
 * sets a signed webinar-scoped cookie, and lands them in the room:
 * YouTube embed + live chat (SSE; persisted messages). Chat is open
 * exactly while status = live unless staff force it open/closed.
 * Host replies are badged; staff can hide a message (gone for
 * visitors, still visible to admin, marked).
 *
 * Part 1 — pure helpers: code shape (7 chars, no ambiguous glyphs),
 *   slugify, Eastern→UTC conversion across EST/EDT, email/phone
 *   validation, NY display label, source wiring pins (nav, routes,
 *   portalContacts capture, schema in both migrate branches).
 * Part 2 — HTTP over the real server: staff MFA sign-in; admin CRUD
 *   + code regeneration (old code dies); gate validation matrix +
 *   rate-limit lockout; registration + LeadScout capture + dedupe on
 *   re-entry; room requires the gate session; one webinar's cookie
 *   never opens another; chat lifecycle (closed → live → ended,
 *   forced-open override); visitor post → admin sees it → host reply
 *   badged → hide round-trip; XSS payloads render escaped; SSE
 *   backlog + live push.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b163-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch163', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 47).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b163@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['B163', 'Boot', 'Pass', 'w0w'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B163 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';

const PORT = 33163;
const BASE = `http://127.0.0.1:${PORT}`;

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

/* ================================================================== */
/* Part 1 — pure helpers + wiring pins                                 */
/* ================================================================== */
function part1() {
  let n = 0;
  const webinars = require(path.join(root, 'server', 'webinars.js'));
  {
    const codes = new Set();
    for (let i = 0; i < 200; i++) {
      const c = webinars.generateAccessCode();
      assert.equal(c.length, 7, 'code length 7');
      assert.ok(!/[01OIL]/.test(c), `code has no ambiguous glyphs: ${c}`);
      assert.ok(/^[A-Z2-9]+$/.test(c), `code alphabet: ${c}`);
      codes.add(c);
    }
    assert.ok(codes.size > 190, 'codes are effectively unique');
    n++;
  }
  {
    assert.equal(webinars.slugify('Grow Your Practice! Live Q&A'), 'grow-your-practice-live-q-a');
    assert.equal(webinars.slugify('   '), 'webinar');
    assert.equal(webinars.slugify('A'.repeat(90)).length, 60);
    n++;
  }
  {
    // Eastern wall time → UTC: EST (Nov) is UTC-5, EDT (Jul) is UTC-4.
    assert.equal(webinars.nyLocalToUtcIso('2026-11-12T19:00'), '2026-11-13T00:00:00.000Z');
    assert.equal(webinars.nyLocalToUtcIso('2026-07-15T19:00'), '2026-07-15T23:00:00.000Z');
    assert.equal(webinars.nyLocalToUtcIso('2026-11-12T19:00:30'), '2026-11-13T00:00:30.000Z');
    assert.equal(webinars.nyLocalToUtcIso('not-a-date'), null);
    assert.equal(webinars.nyLocalToUtcIso(''), null);
    const label = webinars.formatNyTime('2026-11-13T00:00:00.000Z');
    assert.ok(label.includes('Nov 12, 2026') && label.includes('7:00 PM'), `NY label: ${label}`);
    n++;
  }
  {
    assert.ok(webinars.isValidEmail('a@b.co'));
    assert.ok(!webinars.isValidEmail('a@b'));
    assert.ok(!webinars.isValidEmail('a b@c.co'));
    assert.ok(webinars.isValidPhone('+1 (610) 555-0123'));
    assert.ok(!webinars.isValidPhone('123'));
    assert.equal(webinars.cleanPhone('+1 (610) 555-0123'), '+16105550123');
    n++;
  }
  {
    // Chat open rule: override wins, else exactly while live.
    assert.equal(webinars.chatEffectivelyOpen({ status: 'live', chatOpen: null }), true);
    assert.equal(webinars.chatEffectivelyOpen({ status: 'scheduled', chatOpen: null }), false);
    assert.equal(webinars.chatEffectivelyOpen({ status: 'ended', chatOpen: null }), false);
    assert.equal(webinars.chatEffectivelyOpen({ status: 'scheduled', chatOpen: true }), true);
    assert.equal(webinars.chatEffectivelyOpen({ status: 'live', chatOpen: false }), false);
    n++;
  }
  {
    // Gate cookie: signed, webinar-scoped, tamper-evident.
    const token = webinars.signGateCookie(5, 42);
    assert.deepEqual(webinars.verifyGateCookie(5, token), { registrationId: 42 });
    assert.equal(webinars.verifyGateCookie(6, token), null, 'cookie never crosses webinars');
    assert.equal(webinars.verifyGateCookie(5, token.slice(0, -2) + 'xx'), null, 'tampered signature rejected');
    assert.equal(webinars.verifyGateCookie(5, ''), null);
    assert.equal(webinars.cookieName(5), 'bp_webinar_5');
    n++;
  }
  {
    // Wiring pins.
    const nav = read('public/js/navGroups.js');
    assert.ok(nav.includes("'webinars'"), 'navGroups carries webinars');
    const html = read('public/index.html');
    assert.ok(html.includes('data-route="webinars"'), 'sidebar anchor for webinars');
    const app = read('public/js/app.js');
    assert.ok(app.includes('webinars: pageWebinars'), 'PAGES maps webinars');
    assert.ok(app.includes("webinars: 'Webinars'"), 'route label');
    const api = read('public/js/api.js');
    assert.ok(api.includes("adminWebinars: () => get('/admin/webinars')"), 'api.js admin webinars');
    const server = read('server.js');
    assert.ok(server.includes('webinarsPublic'), 'server.js mounts the public router');
    const admin = read('server/routes/admin.js');
    assert.ok(admin.includes("router.get('/webinars'"), 'admin list route');
    assert.ok(admin.includes("router.post('/webinars/:id/regen-code'"), 'admin regen route');
    const contacts = read('server/portalContacts.js');
    assert.ok(contacts.includes('captureFromWebinar'), 'portalContacts captureFromWebinar');
    assert.ok(contacts.includes('webinar_registration_id'), 'leadscout events webinar column');
    const dbjs = read('server/db.js');
    const webinarTables = (dbjs.match(/CREATE TABLE IF NOT EXISTS webinars \(/g) || []).length;
    assert.equal(webinarTables, 2, 'both migrate branches create webinars (sqlite + mysql)');
    assert.ok(dbjs.includes('slug TEXT NOT NULL UNIQUE'), 'sqlite slug unique');
    assert.ok(dbjs.includes('CREATE TABLE IF NOT EXISTS webinar_registrations'), 'registrations table');
    assert.ok(dbjs.includes('CREATE TABLE IF NOT EXISTS webinar_messages'), 'messages table');
    assert.ok(dbjs.includes('uq_webinars_slug') && dbjs.includes('uq_webinar_reg'), 'mysql migrate creates the same tables');
    n++;
  }
  group('Part 1 helpers + wiring', n);
}

/* ================================================================== */
/* Part 2 — HTTP over the real server                                  */
/* ================================================================== */
function makeJar() {
  const cookies = new Map();
  const call = async (method, p, body, opts = {}) => {
    const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
    if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body != null && opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else if (body != null) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  };
  return {
    cookies,
    get: (p, o) => call('GET', p, null, o),
    post: (p, b, o) => call('POST', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    del: (p, o) => call('DELETE', p, null, o),
  };
}
const asJson = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
};

async function staffSignIn() {
  const jar = makeJar();
  const totp = require(path.join(root, 'src', 'totp.js'));
  let res = await jar.post('/api/v1/auth/login', {
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
  });
  assert.equal(res.status, 200, 'staff login 200');
  let body = await asJson(res);
  if (body.data && body.data.mfaRequired) {
    assert.equal(body.data.mfaStage, 'enroll');
    const start = await asJson(await jar.post('/api/v1/auth/mfa/enroll/start', {}));
    res = await jar.post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
    assert.equal(res.status, 200, 'mfa enroll confirm 200');
    body = await asJson(res);
  }
  return jar;
}

async function part2(child, ready) {
  assert.ok(ready, 'server became ready');
  let n = 0;
  const staff = await staffSignIn();
  n++;

  // Admin is staff-only.
  {
    const anon = makeJar();
    const res = await anon.get('/api/v1/admin/webinars');
    assert.equal(res.status, 401, 'anonymous admin webinars refused');
    n++;
  }

  // Create + code shape + share link (code NOT in the link).
  let w;
  {
    const res = await staff.post('/api/v1/admin/webinars', {
      title: 'TEST <script>alert(1)</script> Webinar',
      description: 'Line one',
      scheduledAt: '2026-11-12T19:00',
      youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    assert.equal(res.status, 200, 'create 200');
    const body = await asJson(res);
    w = body.data.webinar;
    assert.equal(w.youtubeId, 'dQw4w9WgXcQ', 'youtube ID parsed from watch URL');
    assert.equal(w.scheduledAt, '2026-11-13T00:00:00.000Z', 'Eastern input stored as UTC');
    assert.ok(/^[A-Z2-9]{7}$/.test(w.accessCode), 'generated code shape');
    assert.ok(w.sharePath === `/webinar/${w.slug}`, 'share path');
    assert.ok(!w.shareUrl.includes(w.accessCode), 'code is NOT embedded in the shareable link');
    assert.equal(w.status, 'scheduled');
    n++;
  }

  // Gate page: title escaped, form fields present.
  const visitor = makeJar();
  {
    const res = await visitor.get(`/webinar/${w.slug}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'webinar title renders escaped on the gate');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'no raw script payload on the gate');
    for (const field of ['name="name"', 'name="email"', 'name="phone"', 'name="code"']) {
      assert.ok(html.includes(field), `gate has ${field}`);
    }
    const missing = await visitor.get('/webinar/definitely-not-a-webinar');
    assert.equal(missing.status, 404, 'unknown slug 404s generically');
    n++;
  }

  // Gate validation matrix.
  {
    const bad = async (fields, marker) => {
      const res = await visitor.post(`/webinar/${w.slug}/enter`, fields, { form: true });
      const html = await res.text();
      assert.equal(res.status, 400, `gate rejects: ${marker}`);
      return html;
    };
    await bad({ email: 'a@b.co', phone: '+16105550123', code: w.accessCode }, 'missing name');
    await bad({ name: 'A Person', email: 'not-an-email', phone: '+16105550123', code: w.accessCode }, 'bad email');
    await bad({ name: 'A Person', email: 'a@b.co', phone: '12', code: w.accessCode }, 'bad phone');
    const html = await bad(
      { name: 'A Person', email: 'a@b.co', phone: '+16105550123', code: 'ZZZZZZZ' },
      'wrong code'
    );
    assert.ok(html.includes('does not match'), 'wrong code gets the one generic error');
    n++;
  }

  // Successful gate entry → registration + cookie + room.
  {
    const res = await visitor.post(
      `/webinar/${w.slug}/enter`,
      { name: 'Test <b>Person</b>', email: 'eliayertey@gmail.com', phone: '+16105550123', code: w.accessCode.toLowerCase() },
      { form: true }
    );
    assert.equal(res.status, 303, 'gate success redirects to the room');
    assert.ok(visitor.cookies.has(`bp_webinar_${w.id}`), 'signed gate cookie set');
    const room = await visitor.get(`/webinar/${w.slug}`);
    const html = await room.text();
    assert.ok(html.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'room carries the embed');
    assert.ok(html.includes("hasn't started yet"), 'scheduled room explains the wait');
    assert.ok(!html.includes('<b>Person</b>'), 'registrant name never renders raw');
    n++;
  }

  // Registration + LeadScout capture + dedupe.
  {
    const res = await staff.get(`/api/v1/admin/webinars/${w.id}/registrations`);
    const regs = (await asJson(res)).data.registrations;
    assert.equal(regs.length, 1, 'one registration');
    assert.ok(regs[0].joinedAt, 'joined_at stamped on room entry');
    assert.ok(regs[0].contactId, 'registration carries the LeadScout contact id');

    const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
    const wsDbPath = path.join(temp, 'workspaces', '1', 'websitescout.db');
    const wdb = new Database(wsDbPath, { readonly: true });
    const contacts = wdb.prepare("SELECT * FROM leadscout_contacts WHERE email_norm = 'eliayertey@gmail.com'").all();
    assert.equal(contacts.length, 1, 'exactly one LeadScout contact');
    const events = wdb
      .prepare('SELECT * FROM leadscout_events WHERE webinar_registration_id = ?')
      .all(regs[0].id);
    assert.equal(events.length, 1, 'exactly one capture event');
    assert.ok(events[0].source_label.startsWith('Webinar — '), `source attribution: ${events[0].source_label}`);
    wdb.close();

    // Re-entry with the same email (different case) duplicates nothing.
    const again = makeJar();
    const re = await again.post(
      `/webinar/${w.slug}/enter`,
      { name: 'Test Person', email: 'ELIAYERTEY@GMAIL.COM', phone: '+16105550123', code: w.accessCode },
      { form: true }
    );
    assert.equal(re.status, 303);
    const regs2 = (await asJson(await staff.get(`/api/v1/admin/webinars/${w.id}/registrations`))).data.registrations;
    assert.equal(regs2.length, 1, 're-entry does not duplicate the registration');
    const wdb2 = new Database(wsDbPath, { readonly: true });
    assert.equal(
      wdb2.prepare("SELECT COUNT(*) c FROM leadscout_contacts WHERE email_norm = 'eliayertey@gmail.com'").get().c,
      1,
      're-entry does not duplicate the contact'
    );
    assert.equal(
      wdb2.prepare('SELECT COUNT(*) c FROM leadscout_events WHERE webinar_registration_id = ?').get(regs[0].id).c,
      1,
      're-entry does not duplicate the capture event'
    );
    wdb2.close();
    n++;
  }

  // Room requires the gate session; a cookie never crosses webinars.
  let w2;
  {
    const anonV = makeJar();
    const res = await anonV.get(`/webinar/${w.slug}/chat/messages`);
    assert.equal(res.status, 401, 'chat without gate session refused');
    const created = await asJson(
      await staff.post('/api/v1/admin/webinars', { title: 'TEST Webinar Two', youtube: 'dQw4w9WgXcQ' })
    );
    w2 = created.data.webinar;
    const cross = await visitor.get(`/webinar/${w2.slug}/chat/messages`);
    assert.equal(cross.status, 401, "webinar A's cookie never opens webinar B");
    const gateB = await visitor.get(`/webinar/${w2.slug}`);
    assert.ok((await gateB.text()).includes('Webinar code'), "webinar B still shows its gate to A's registrant");
    n++;
  }

  // Chat lifecycle: closed while scheduled.
  {
    const res = await visitor.post(`/webinar/${w.slug}/chat`, { body: 'too early' });
    assert.equal(res.status, 403, 'chat closed before live');
    n++;
  }

  // Go live: visitor posts, admin sees it, host replies (badged),
  // admin hides the visitor's XSS message — gone for visitors only.
  let xssId;
  {
    const patch = await staff.patch(`/api/v1/admin/webinars/${w.id}`, { status: 'live' });
    assert.equal(patch.status, 200);
    const post1 = await visitor.post(`/webinar/${w.slug}/chat`, { body: 'Hello from the audience!' });
    assert.equal(post1.status, 200, 'visitor can post while live');
    const post2 = await visitor.post(`/webinar/${w.slug}/chat`, { body: '<script>alert(2)</script>' });
    xssId = (await asJson(post2)).message.id;

    const adminList = (await asJson(await staff.get(`/api/v1/admin/webinars/${w.id}/messages`))).data.messages;
    assert.equal(adminList.length, 2, 'admin console sees both messages');
    assert.equal(adminList[0].authorName, 'Test Person', 'author is the registered name (markup stripped at intake)');
    const reply = await staff.post(`/api/v1/admin/webinars/${w.id}/messages`, { body: 'Welcome everyone!' });
    const replyBody = await asJson(reply);
    assert.equal(replyBody.data.message.isHost, true, 'host reply is badged');

    const vList = (await asJson(await visitor.get(`/webinar/${w.slug}/chat/messages`))).messages;
    assert.equal(vList.length, 3, 'visitor sees the host reply in the stream');

    const hide = await staff.post(`/api/v1/admin/webinars/${w.id}/messages/${xssId}/hide`, { hidden: true });
    assert.equal((await asJson(hide)).data.message.hidden, true);
    const vAfter = (await asJson(await visitor.get(`/webinar/${w.slug}/chat/messages`))).messages;
    assert.equal(vAfter.length, 2, 'hidden message leaves the visitor view');
    const aAfter = (await asJson(await staff.get(`/api/v1/admin/webinars/${w.id}/messages`))).data.messages;
    assert.equal(aAfter.length, 3, 'hidden message remains for admin');
    assert.equal(aAfter.find((m) => m.id === xssId).hidden, true, 'admin sees it marked hidden');
    n++;
  }

  // SSE: backlog arrives on connect, then a live push.
  {
    const cookieHeader = [...visitor.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const streamData = await new Promise((resolve, reject) => {
      const req = http.get(
        `${BASE}/webinar/${w.slug}/chat/stream`,
        { headers: { cookie: cookieHeader, 'x-forwarded-proto': 'https' } },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.ok(String(res.headers['content-type']).includes('text/event-stream'));
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            if (buf.includes('SSE live push')) {
              req.destroy();
              resolve(buf);
            }
          });
          res.on('error', () => resolve(buf));
          setTimeout(async () => {
            await visitor.post(`/webinar/${w.slug}/chat`, { body: 'SSE live push' });
          }, 300);
          setTimeout(() => {
            req.destroy();
            resolve(buf);
          }, 5000);
        }
      );
      req.on('error', reject);
    });
    assert.ok(streamData.includes('Hello from the audience'), 'SSE replays the backlog');
    assert.ok(streamData.includes('SSE live push'), 'SSE pushes new messages live');
    assert.ok(!streamData.includes('alert(2)'), 'SSE never carries the hidden message');
    n++;
  }

  // Ended: chat closes, history stays readable.
  {
    await staff.patch(`/api/v1/admin/webinars/${w.id}`, { status: 'ended' });
    const post = await visitor.post(`/webinar/${w.slug}/chat`, { body: 'after end' });
    assert.equal(post.status, 403, 'chat closed after ended');
    const history = await asJson(await visitor.get(`/webinar/${w.slug}/chat/messages`));
    assert.ok(history.messages.length >= 3, 'history remains readable after ended');
    n++;
  }

  // Forced-open override beats status.
  {
    await staff.patch(`/api/v1/admin/webinars/${w2.id}`, { chatOpen: true });
    const v2 = makeJar();
    const w2cur = (await asJson(await staff.get('/api/v1/admin/webinars'))).data.webinars.find((x) => x.id === w2.id);
    const enter = await v2.post(
      `/webinar/${w2.slug}/enter`,
      { name: 'Second Person', email: 'second@example.invalid', phone: '+16105550129', code: w2cur.accessCode },
      { form: true }
    );
    assert.equal(enter.status, 303);
    const post = await v2.post(`/webinar/${w2.slug}/chat`, { body: 'forced open works' });
    assert.equal(post.status, 200, 'forced-open chat accepts posts while scheduled');
    n++;
  }

  // Code regeneration: old code dies, new code works.
  {
    const before = (await asJson(await staff.get('/api/v1/admin/webinars'))).data.webinars.find((x) => x.id === w2.id);
    const regen = await staff.post(`/api/v1/admin/webinars/${w2.id}/regen-code`, {});
    const after = (await asJson(regen)).data.webinar;
    assert.notEqual(after.accessCode, before.accessCode, 'regenerated code differs');
    const v3 = makeJar();
    const oldTry = await v3.post(
      `/webinar/${w2.slug}/enter`,
      { name: 'Old Code', email: 'old@example.invalid', phone: '+16105550130', code: before.accessCode },
      { form: true }
    );
    assert.equal(oldTry.status, 400, 'old code rejected after regeneration');
    const newTry = await v3.post(
      `/webinar/${w2.slug}/enter`,
      { name: 'New Code', email: 'new@example.invalid', phone: '+16105550130', code: after.accessCode },
      { form: true }
    );
    assert.equal(newTry.status, 303, 'new code works');
    n++;
  }

  // Rate limit: the gate locks out after the attempt ceiling.
  {
    const w3 = (await asJson(await staff.post('/api/v1/admin/webinars', { title: 'TEST Webinar Three' }))).data.webinar;
    const hammer = makeJar();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await hammer.post(
        `/webinar/${w3.slug}/enter`,
        { name: 'X Y', email: 'x@example.invalid', phone: '+16105550131', code: `BAD${i}XX` },
        { form: true }
      );
      last = res.status;
      await res.text();
    }
    assert.equal(last, 429, 'gate locks out after repeated attempts');
    const del = await staff.del(`/api/v1/admin/webinars/${w3.id}`);
    assert.equal(del.status, 200, 'webinar delete works');
    const gone = await makeJar().get(`/webinar/${w3.slug}`);
    assert.equal(gone.status, 404, 'deleted webinar gate is gone');
    n++;
  }

  group('Part 2 HTTP end-to-end', n);
  // Cleanup of the two remaining fixtures happens implicitly with the
  // temp platform DB; the live deploy proof does its own cleanup.
  return { w, w2 };
}

/* ================================================================== */
(async () => {
  console.log('batch163 webinars:');
  part1();
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
    for (let i = 0; i < 300 && !ready; i++) {
      if (child.exitCode != null) throw new Error('server exited early: ' + output);
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    await part2(child, ready);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  console.log(`\nbatch163 webinars: PASS — ${groups.length} groups`);
})().catch((e) => {
  console.error('batch163 webinars: FAIL');
  console.error(e);
  process.exit(1);
});
