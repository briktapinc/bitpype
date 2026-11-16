'use strict';
/**
 * Batch 194 — Portal Learning (Training) + Packages + Student type.
 * Boots the real server (sqlite or MySQL via REGRESSION_DB_DRIVER)
 * and drives it over HTTP:
 *   unit: factory student = [training, packages] / modules []
 *   student login → /me exact tabs+modules → other tabs 403
 *   GET /training = 17 seeded modules in order, video + transcript
 *   GET /packages = plan catalog; owner GET /packages → 403
 *   admin: unpublish hides a module, reorder reflects, create/delete
 *   conversion: convertStudentForBillingUser + a fake completed
 *   checkout webhook event flips student → owner + audit row;
 *   an unrelated/expired event flips nothing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpype-b194-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.SESSION_SECRET = ['batch194', 'fixture', 'secret', 'value'].join('-');
process.env.NODE_ENV = 'production';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const PORT = 31494;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}

const STUDENT_EMAIL = 'student194@example.invalid';
const STUDENT2_EMAIL = 'student194b@example.invalid';
const OWNER_EMAIL = 'owner194@example.invalid';
const PORTAL_PASSWORD = 'PortalPass194!';
const ADMIN_EMAIL = 'admin194@example.invalid';
const ADMIN_PASSWORD = 'AdminPass194!';

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

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const bcrypt = require('bcryptjs');
  const tabs = require(path.join(root, 'server/portalTabs.js'));

  // ---- unit: student factory defaults + type registry ----
  check('USER_TYPES includes student', tabs.USER_TYPES.includes('student'));
  check(
    'factory student tabs = [training, packages]',
    JSON.stringify(tabs.effectiveTabs('student', null)) === '["training","packages"]'
  );
  check('factory student modules = []', JSON.stringify(tabs.effectiveModules('student', null)) === '[]');
  check(
    'factory owner tabs = 17 (training in, packages out)',
    tabs.effectiveTabs('owner', null).length === 17 &&
      tabs.effectiveTabs('owner', null).includes('training') &&
      !tabs.effectiveTabs('owner', null).includes('packages')
  );
  check(
    'factory renter unchanged',
    JSON.stringify(tabs.effectiveTabs('renter', null)) === '["website","modules","rentals"]'
  );
  const cfg = tabs.resolveTypeDefaults(JSON.stringify({ student: { tabs: ['training'], modules: [] } }));
  check('configured student slice sanitizes', JSON.stringify(cfg.tabs.student) === '["training"]');
  check('student tab override can grant forms', tabs.effectiveTabs('student', { forms: true }).includes('forms'));

  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const hash = (pw) => bcrypt.hashSync(pw, 12);

  // staff admin
  await db.query('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
    e: ADMIN_EMAIL,
    h: hash(ADMIN_PASSWORD),
    n: 'Fixture Admin',
    s: 'active',
  });
  // workspace 1 leads for the portal users
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb
    .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (601, ?, ?, ?)')
    .run('Student Biz', STUDENT_EMAIL, 'lead');
  wdb
    .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (602, ?, ?, ?)')
    .run('Owner Biz', OWNER_EMAIL, 'customer');
  wdb
    .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (603, ?, ?, ?)')
    .run('Student Biz B', STUDENT2_EMAIL, 'lead');

  const portalHash = hash(PORTAL_PASSWORD);
  const insPortal = async (email, leadId, type) => {
    const r = await db.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, 1, :l, :b, 'active', :t)`,
      { e: email, h: portalHash, l: leadId, b: 'Fixture', t: type }
    );
    return Number(r.insertId);
  };
  const studentId = await insPortal(STUDENT_EMAIL, 601, 'student');
  const student2Id = await insPortal(STUDENT2_EMAIL, 603, 'student');
  const ownerId = await insPortal(OWNER_EMAIL, 602, 'owner');
  check('seeded student/owner portal users', studentId > 0 && student2Id > 0 && ownerId > 0);
  // boot cleanup must NOT reset student rows (db.js user_type guard)
  const bootRows = await db.query('SELECT user_type FROM client_portal_users WHERE id = :id', { id: studentId });
  check('student user_type survives in table', bootRows[0] && bootRows[0].user_type === 'student');

  // ---- boot the real server ----
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

    const studentJar = makeJar();
    const ownerJar = makeJar();
    const adminJar = makeJar();
    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (jar, p) => jar.fetch(BASE + p);
    const patch = (jar, p, body) => jar.fetch(BASE + p, { method: 'PATCH', body: JSON.stringify(body || {}) });
    const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
    const del = (jar, p) => jar.fetch(BASE + p, { method: 'DELETE' });

    const totp = require(path.join(root, 'src/totp.js'));
    async function completeStaffMfa(jar, loginRes) {
      const body = await json(loginRes);
      if (!body || !body.data || !body.data.mfaRequired) return body;
      if (body.data.mfaStage === 'enroll') {
        const start = await json(await post(jar, '/api/v1/auth/mfa/enroll/start', {}));
        const done = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
        return json(done);
      }
      return body;
    }

    // ---- student session ----
    let res = await post(studentJar, '/api/v1/portal/login', { email: STUDENT_EMAIL, password: PORTAL_PASSWORD });
    check('student portal login 200', res.status === 200);
    let me = (await json(await get(studentJar, '/api/v1/portal/me'))).data;
    check('/me student: userType student', me.client.userType === 'student');
    check(
      '/me student: tabs exactly [training, packages]',
      JSON.stringify(me.client.visibleTabs) === '["training","packages"]'
    );
    check('/me student: modules exactly []', JSON.stringify(me.client.visibleModules) === '[]');

    // ---- tab enforcement for the student ----
    for (const p of ['/billing', '/forms', '/leadscout/contacts', '/modules', '/rentals', '/assistant/status']) {
      res = await get(studentJar, '/api/v1/portal' + p);
      const body = await json(res);
      check(`student GET ${p} → 403 TAB_FORBIDDEN`, res.status === 403 && body.code === 'TAB_FORBIDDEN');
    }

    // ---- training catalog (seeded) ----
    res = await get(studentJar, '/api/v1/portal/training');
    let trainBody = await json(res);
    check('student GET /training 200', res.status === 200);
    const mods = (trainBody.data && trainBody.data.modules) || [];
    check('training: 17 seeded modules', mods.length === 17);
    check('training: first module is Welcome', mods[0] && mods[0].title === 'Welcome to Your Portal');
    check('training: last module is Wrapping Up', mods[16] && /Wrapping Up/.test(mods[16].title));
    check(
      'training: modules carry video + transcript',
      mods.every((m) => m.videoUrl && m.transcript && m.transcript.length > 40)
    );
    check(
      'training: sort order ascending',
      mods.every((m, i) => i === 0 || mods[i - 1].sortOrder <= m.sortOrder)
    );

    // ---- packages catalog ----
    res = await get(studentJar, '/api/v1/portal/packages');
    const pkgBody = await json(res);
    check('student GET /packages 200', res.status === 200);
    const planIds = ((pkgBody.data && pkgBody.data.plans) || []).map((p) => p.id);
    check(
      'packages: catalog has free/standard/pro/premium',
      ['free', 'standard', 'pro', 'premium'].every((id) => planIds.includes(id))
    );
    res = await post(studentJar, '/api/v1/portal/packages/checkout', { plan: 'standard' });
    const coBody = await json(res);
    check(
      'student POST /packages/checkout is NOT tab-forbidden (engine answers)',
      !(res.status === 403 && coBody.code === 'TAB_FORBIDDEN')
    );

    // ---- owner contrast ----
    res = await post(ownerJar, '/api/v1/portal/login', { email: OWNER_EMAIL, password: PORTAL_PASSWORD });
    check('owner portal login 200', res.status === 200);
    me = (await json(await get(ownerJar, '/api/v1/portal/me'))).data;
    check(
      '/me owner: 17 tabs incl training, excl packages',
      me.client.visibleTabs.length === 17 &&
        me.client.visibleTabs.includes('training') &&
        !me.client.visibleTabs.includes('packages')
    );
    res = await get(ownerJar, '/api/v1/portal/training');
    check('owner GET /training 200', res.status === 200);
    res = await get(ownerJar, '/api/v1/portal/packages');
    check('owner GET /packages → 403 TAB_FORBIDDEN', res.status === 403 && (await json(res)).code === 'TAB_FORBIDDEN');

    // ---- admin training management ----
    res = await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    check('staff admin login 200', res.status === 200);
    await completeStaffMfa(adminJar, res);
    res = await get(adminJar, '/api/v1/admin/training-modules');
    const admBody = await json(res);
    check('admin GET /training-modules 200 with 17', res.status === 200 && (admBody.data.modules || []).length === 17);
    const second = admBody.data.modules[1];

    // unpublish module 2 → hidden from the portal, still in admin list
    res = await patch(adminJar, `/api/v1/admin/training-modules/${second.id}`, { published: false });
    check('admin unpublish 200', res.status === 200 && (await json(res)).data.module.published === false);
    res = await get(studentJar, '/api/v1/portal/training');
    trainBody = await json(res);
    check(
      'portal training drops to 16 when one unpublished',
      trainBody.data.modules.length === 16 && !trainBody.data.modules.some((m) => m.id === second.id)
    );
    res = await patch(adminJar, `/api/v1/admin/training-modules/${second.id}`, { published: true });
    check('admin republish 200', res.status === 200);

    // reorder: reverse the whole list → portal order flips
    const allIds = admBody.data.modules.map((m) => m.id);
    res = await put(adminJar, '/api/v1/admin/training-modules/reorder', { orderedIds: [...allIds].reverse() });
    check('admin reorder 200', res.status === 200);
    res = await get(studentJar, '/api/v1/portal/training');
    trainBody = await json(res);
    check(
      'portal order follows admin reorder',
      trainBody.data.modules[0].id === allIds[allIds.length - 1] && trainBody.data.modules[16].id === allIds[0]
    );
    res = await put(adminJar, '/api/v1/admin/training-modules/reorder', { orderedIds: allIds });
    check('admin reorder restore 200', res.status === 200);

    // create + edit + delete
    res = await post(adminJar, '/api/v1/admin/training-modules', {
      title: 'Fixture Extra Module',
      videoUrl: '/training/extra.mp4',
      transcript: 'A fixture transcript long enough to be a real transcript body.',
      published: true,
    });
    const created = (await json(res)).data.module;
    check('admin create module 200', res.status === 200 && created && created.title === 'Fixture Extra Module');
    res = await get(studentJar, '/api/v1/portal/training');
    trainBody = await json(res);
    check('created module appears in portal (18)', trainBody.data.modules.length === 18);
    res = await patch(adminJar, `/api/v1/admin/training-modules/${created.id}`, { title: 'Fixture Extra Module v2' });
    check(
      'admin edit module title',
      res.status === 200 && (await json(res)).data.module.title === 'Fixture Extra Module v2'
    );
    res = await del(adminJar, `/api/v1/admin/training-modules/${created.id}`);
    check('admin delete module 200', res.status === 200);
    res = await get(studentJar, '/api/v1/portal/training');
    trainBody = await json(res);
    check('deleted module gone from portal (17)', trainBody.data.modules.length === 17);

    // ---- conversion: direct + webhook paths ----
    // billing users for both students (what a checkout would resolve)
    const mkBillingUser = async (email) => {
      // The Packages checkout above already provisions a billing user
      // for the student's own email (ensureBillingUserForPortalClient)
      // — reuse it when present, insert only when absent.
      const existing = await db.query('SELECT id FROM users WHERE email = :e LIMIT 1', { e: email });
      if (existing && existing[0]) return Number(existing[0].id);
      const r = await db.query(
        'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
        { e: email, h: hash('UnusedPass194!'), n: 'Billing Fixture', s: 'active' }
      );
      return Number(r.insertId);
    };
    const billingUser1 = await mkBillingUser(STUDENT_EMAIL);
    const billingUser2 = await mkBillingUser(STUDENT2_EMAIL);
    const conversion = require(path.join(root, 'server/studentConversion.js'));

    // negative first: an unrelated billing user converts nobody
    const stranger = await mkBillingUser('stranger194@example.invalid');
    let out = await conversion.convertStudentForBillingUser(stranger, 'test');
    check('conversion: unrelated billing user converts nobody', out.converted.length === 0);
    let rows = await db.query('SELECT user_type FROM client_portal_users WHERE id = :id', { id: studentId });
    check('conversion: student untouched by unrelated purchase', rows[0].user_type === 'student');

    // direct conversion of student 1
    out = await conversion.convertStudentForBillingUser(billingUser1, 'test');
    check('conversion: direct call converts student 1', JSON.stringify(out.converted) === JSON.stringify([studentId]));
    rows = await db.query('SELECT user_type FROM client_portal_users WHERE id = :id', { id: studentId });
    check('conversion: student 1 is now owner', rows[0].user_type === 'owner');
    const auditRows = await db.query(
      "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'portal_user.student_converted'"
    );
    check('conversion: audit row written', Number(auditRows[0].n) >= 1);
    out = await conversion.convertStudentForBillingUser(billingUser1, 'test');
    check('conversion: idempotent (second call no-op)', out.converted.length === 0);

    // webhook path for student 2: a completed subscription checkout.
    // The dispatch continues into a Stripe retrieve that cannot
    // succeed in the fixture (no keys) — the conversion hook runs
    // FIRST, so the flip must land even though dispatch throws.
    const billing = require(path.join(root, 'server/billing.js'));
    const evt = {
      id: 'evt_b194_fixture_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_b194',
          mode: 'subscription',
          metadata: { user_id: String(billingUser2) },
          customer: 'cus_b194',
          subscription: 'sub_b194',
        },
      },
    };
    let threw = false;
    try {
      await billing.handleWebhookEvent(evt);
    } catch {
      threw = true;
    }
    rows = await db.query('SELECT user_type FROM client_portal_users WHERE id = :id', { id: student2Id });
    check(
      `conversion: webhook checkout flips student 2 (dispatch threw later: ${threw})`,
      rows[0].user_type === 'owner'
    );

    // converted student 1 now sees the owner portal over HTTP
    me = (await json(await get(studentJar, '/api/v1/portal/me'))).data;
    check(
      'converted student /me: owner tabs (17)',
      me.client.userType === 'owner' && me.client.visibleTabs.length === 17
    );

    console.log(JSON.stringify({ passed: true, groups: results.length, checks: results }));
  } finally {
    child.kill('SIGTERM');
    await closed;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
