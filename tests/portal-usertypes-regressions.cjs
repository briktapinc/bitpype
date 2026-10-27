'use strict';
/**
 * Batch 29 — portal user types, tab/module access, admin-configured
 * type defaults. Boots the real server on sqlite (isolated temp dirs)
 * and drives it over HTTP:
 *   migration backfill → owner baseline → renter tab 403s → renter
 *   module list = calltracking only → module endpoint 403s → per-user
 *   module override → admin-changed type defaults (no user-row edit)
 *   → override still wins → reset → restore owner → staff-only admin.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpype-usertypes-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.SESSION_SECRET = ['usertypes','fixture','secret'].join('-');
process.env.NODE_ENV = 'production';

const PORT = 31399;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}

const PORTAL_EMAIL = 'legacy29@example.invalid';
const PORTAL_PASSWORD = 'PortalPass29!';
const ADMIN_EMAIL = 'admin29@example.invalid';
const ADMIN_PASSWORD = 'AdminPass29!';
const STAFF_EMAIL = 'staff29@example.invalid';
const STAFF_PASSWORD = 'StaffPass29!';

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      // Session cookies are Secure (APP_URL is https, as in production);
      // present as https-behind-proxy like the real nginx hop, or
      // express-session withholds Set-Cookie on plain-http requests.
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
  const RawDb = require('better-sqlite3');
  const tabs = require(path.join(root, 'server/portalTabs.js'));

  // ---- unit: effective-set logic + configured-default resolution ----
  check('factory renter tabs', JSON.stringify(tabs.effectiveTabs('renter', null)) === '["website","modules","rentals"]');
  check('factory renter modules = calltracking only', JSON.stringify(tabs.effectiveModules('renter', null)) === '["calltracking"]');
  check('factory owner modules = all site module types', tabs.effectiveModules('owner', null).join(',') === tabs.PORTAL_MODULES.join(','));
  check('module keys mirror siteModules.MODULE_TYPES', tabs.PORTAL_MODULES.join(',') === require(path.join(root, 'server/siteModules.js')).MODULE_TYPES.join(','));
  check('tab override wins over factory', tabs.effectiveTabs('renter', { forms: true, modules: false }).join(',') === 'website,forms,rentals');
  check('module override wins over factory', tabs.effectiveModules('renter', { faq: true }).join(',') === 'faq,calltracking');
  const cfg = tabs.resolveTypeDefaults(JSON.stringify({ renter: { modules: ['faq', 'calltracking', 'bogus'], tabs: ['website', 'modules', 'rentals'] } }));
  check('configured renter modules sanitized (unknown dropped)', cfg.modules.renter.join(',') === 'faq,calltracking');
  check('configured change alters effective set', tabs.effectiveModules('renter', null, cfg).join(',') === 'faq,calltracking');
  check('per-user override beats configured default', tabs.effectiveModules('renter', { faq: false }, cfg).join(',') === 'calltracking');
  check('garbage stored config falls back to factory', tabs.resolveTypeDefaults('{{{nope').modules.renter.join(',') === 'calltracking');
  check('non-array slice falls back to factory slice', tabs.resolveTypeDefaults({ renter: { modules: 'faq' } }).modules.renter.join(',') === 'calltracking');

  // ---- pre-migration DB: old client_portal_users shape + a legacy user ----
  const pre = new RawDb(process.env.SQLITE_PATH);
  pre.exec(`CREATE TABLE client_portal_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, workspace_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
    business_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  pre
    .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?,?,?,?,?,?)')
    .run(PORTAL_EMAIL, bcrypt.hashSync(PORTAL_PASSWORD, 12), 1, 501, 'QA Fixture Biz', 'active');
  pre.close();

  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();

  const probe = new RawDb(process.env.SQLITE_PATH, { readonly: true });
  const cols = probe.prepare('PRAGMA table_info(client_portal_users)').all().map((c) => c.name);
  check('migration adds user_type/nav_overrides/module_overrides', ['user_type', 'nav_overrides', 'module_overrides'].every((c) => cols.includes(c)));
  const legacy = probe.prepare('SELECT user_type, nav_overrides, module_overrides FROM client_portal_users WHERE id = 1').get();
  check('migration backfills legacy user to owner, no overrides', legacy.user_type === 'owner' && legacy.nav_overrides === null && legacy.module_overrides === null);
  probe.close();

  // ---- seed staff users + the plan-link row for the portal email ----
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: ADMIN_EMAIL, h: hash(ADMIN_PASSWORD), n: 'Fixture Admin', s: 'active' }
  );
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
    { e: STAFF_EMAIL, h: hash(STAFF_PASSWORD), n: 'Fixture Staff', s: 'active' }
  );
  // A platform user row sharing the portal email unlocks the plan for
  // portal module calls (effectivePlan email link — same as production).
  await db.query(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)',
    { e: PORTAL_EMAIL, h: hash('UnusedPass29!'), n: 'QA Fixture Biz', s: 'active' }
  );

  // ---- seed workspace 1: owner lead 501, tenant lead 777, live rental ----
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('QA Fixture Biz', PORTAL_EMAIL, 'customer');
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)').run('Tenant Biz', 'tenant29@example.invalid', 'customer');
  const site = wdb.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (501, ?, ?, ?, ?)').run('Fixture Site', '{}', '[]', 'draft');
  require(path.join(root, 'server/rentals.js')).ensureRentals(wdb);
  wdb.prepare('INSERT INTO site_rentals (website_id, tenant_lead_id, owner_lead_id, status) VALUES (?, 777, 501, ?)').run(Number(site.lastInsertRowid), 'active');

  const portalSvc = require(path.join(root, 'server/clientPortal.js'));
  check('creation default: live-rental tenant lead → renter', portalSvc.defaultUserTypeForLead(1, 777) === 'renter');
  check('creation default: site owner lead → owner', portalSvc.defaultUserTypeForLead(1, 501) === 'owner');

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

    const portalJar = makeJar();
    const adminJar = makeJar();
    const staffJar = makeJar();
    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (jar, p) => jar.fetch(BASE + p);
    const patch = (jar, p, body) => jar.fetch(BASE + p, { method: 'PATCH', body: JSON.stringify(body || {}) });
    const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });

    // ---- owner baseline ----
    let res = await post(portalJar, '/api/v1/portal/login', { email: PORTAL_EMAIL, password: PORTAL_PASSWORD });
    check('portal login (owner) 200', res.status === 200);
    let me = (await json(await get(portalJar, '/api/v1/portal/me'))).data;
    check('/me owner: userType owner', me.client.userType === 'owner');
    check('/me owner: all 12 tabs', me.client.visibleTabs.length === 12);
    check('/me owner: all 19 modules', me.client.visibleModules.length === 19);
    let mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('owner module list = 19', Array.isArray(mods.modules) && mods.modules.length === 19);
    const userId = me.client.id;

    // ---- admin surface ----
    res = await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    check('staff admin login 200', res.status === 200);
    const adminList = (await json(await get(adminJar, '/api/v1/admin/portal-users'))).data;
    const listed = (adminList.users || []).find((u) => u.id === userId);
    check('admin lists portal user as owner', !!listed && listed.userType === 'owner');
    check('admin payload: configured defaults are factory (renter tabs)', JSON.stringify(adminList.typeDefaults.renter) === '["website","modules","rentals"]');
    check('admin payload: configured module defaults (renter = calltracking)', JSON.stringify(adminList.moduleTypeDefaults.renter) === '["calltracking"]');
    check('admin payload: 12 tabs + 19 modules metadata', adminList.tabs.length === 12 && adminList.modules.length === 19);

    // ---- flip to renter: tabs enforced ----
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { user_type: 'renter' });
    let patched = (await json(res)).data.user;
    check('PATCH type=renter: visibleTabs = website/modules/rentals', JSON.stringify(patched.visibleTabs) === '["website","modules","rentals"]');
    check('PATCH type=renter: visibleModules = calltracking', JSON.stringify(patched.visibleModules) === '["calltracking"]');
    me = (await json(await get(portalJar, '/api/v1/portal/me'))).data;
    check('/me renter: exact tabs', JSON.stringify(me.client.visibleTabs) === '["website","modules","rentals"]');
    check('/me renter: exact modules', JSON.stringify(me.client.visibleModules) === '["calltracking"]');
    res = await get(portalJar, '/api/v1/portal/billing');
    check('renter GET /billing → 403 TAB_FORBIDDEN', res.status === 403 && (await json(res)).code === 'TAB_FORBIDDEN');
    res = await get(portalJar, '/api/v1/portal/leadscout/contacts');
    check('renter GET /leadscout/contacts → 403 TAB_FORBIDDEN', res.status === 403 && (await json(res)).code === 'TAB_FORBIDDEN');
    res = await get(portalJar, '/api/v1/portal/forms');
    check('renter GET /forms → 403 TAB_FORBIDDEN', res.status === 403 && (await json(res)).code === 'TAB_FORBIDDEN');
    res = await get(portalJar, '/api/v1/portal/rentals');
    check('renter GET /rentals → 200', res.status === 200);

    // ---- renter: modules enforced ----
    mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('renter module list = calltracking only', Array.isArray(mods.modules) && mods.modules.length === 1 && mods.modules[0].type === 'calltracking');
    res = await get(portalJar, '/api/v1/portal/modules/calltracking');
    check('renter GET /modules/calltracking (call log) → 200', res.status === 200);
    res = await put(portalJar, '/api/v1/portal/modules/calltracking/config', { phone_number: '+16105550100' });
    const ctSaved = await json(res);
    check('renter PUT calltracking phone → 200', res.status === 200 && ctSaved.data && ctSaved.data.phone_number === '+16105550100');
    res = await get(portalJar, '/api/v1/portal/modules/chatbot');
    check('renter GET /modules/chatbot → 403 MODULE_FORBIDDEN', res.status === 403 && (await json(res)).code === 'MODULE_FORBIDDEN');
    res = await get(portalJar, '/api/v1/portal/modules/blog');
    check('renter GET /modules/blog → 403 MODULE_FORBIDDEN', res.status === 403 && (await json(res)).code === 'MODULE_FORBIDDEN');
    res = await get(portalJar, '/api/v1/portal/modules/bookings/admin');
    check('renter GET /modules/bookings/admin → 403 MODULE_FORBIDDEN', res.status === 403 && (await json(res)).code === 'MODULE_FORBIDDEN');
    res = await post(portalJar, '/api/v1/portal/modules/upload-image', {});
    check('renter POST /modules/upload-image → 403 (owner-only unmapped)', res.status === 403 && (await json(res)).code === 'MODULE_FORBIDDEN');

    // ---- per-user module override grants FAQ ----
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { module_overrides: { faq: true } });
    patched = (await json(res)).data.user;
    check('module override faq:true → visibleModules gains faq', patched.visibleModules.includes('faq') && patched.visibleModules.includes('calltracking'));
    mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('module list reflects override', mods.modules.map((m) => m.type).sort().join(',') === 'calltracking,faq');
    res = await get(portalJar, '/api/v1/portal/modules/faq');
    check('GET /modules/faq with override → 200', res.status === 200);
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { module_overrides: {} });
    patched = (await json(res)).data.user;
    check('clearing module overrides → back to calltracking', JSON.stringify(patched.visibleModules) === '["calltracking"]');

    // ---- admin-changed type default moves the renter (user row untouched) ----
    const factoryConfig = {
      owner: { tabs: tabs.FACTORY_DEFAULTS.tabs.owner, modules: tabs.FACTORY_DEFAULTS.modules.owner },
      renter: { tabs: tabs.FACTORY_DEFAULTS.tabs.renter, modules: tabs.FACTORY_DEFAULTS.modules.renter },
    };
    const withFaq = structuredClone(factoryConfig);
    withFaq.renter.modules = ['calltracking', 'faq'];
    res = await put(adminJar, '/api/v1/admin/portal-access-defaults', withFaq);
    check('PUT portal-access-defaults (renter +faq module) 200', res.status === 200);
    mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('type-default change: renter list gains faq without user edit', mods.modules.map((m) => m.type).sort().join(',') === 'calltracking,faq');
    res = await get(portalJar, '/api/v1/portal/modules/faq');
    check('type-default change: GET /modules/faq → 200', res.status === 200);
    // per-user override still wins over the admin-changed default
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { module_overrides: { faq: false } });
    mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('override faq:false beats configured default', mods.modules.map((m) => m.type).join(',') === 'calltracking');
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { reset_overrides: true });
    mods = (await json(await get(portalJar, '/api/v1/portal/modules'))).data;
    check('reset overrides → configured default applies again', mods.modules.map((m) => m.type).sort().join(',') === 'calltracking,faq');

    // ---- admin-changed TAB default moves the renter too ----
    const withForms = structuredClone(factoryConfig);
    withForms.renter.tabs = ['website', 'modules', 'rentals', 'forms'];
    res = await put(adminJar, '/api/v1/admin/portal-access-defaults', withForms);
    check('PUT portal-access-defaults (renter +forms tab) 200', res.status === 200);
    me = (await json(await get(portalJar, '/api/v1/portal/me'))).data;
    check('type-default tab change: /me gains forms', me.client.visibleTabs.includes('forms'));
    res = await get(portalJar, '/api/v1/portal/forms');
    check('type-default tab change: GET /forms → 200', res.status === 200);
    res = await put(adminJar, '/api/v1/admin/portal-access-defaults', factoryConfig);
    check('PUT factory defaults restored 200', res.status === 200);
    me = (await json(await get(portalJar, '/api/v1/portal/me'))).data;
    check('after factory restore: renter tabs back to 3', JSON.stringify(me.client.visibleTabs) === '["website","modules","rentals"]');
    check('after factory restore: renter modules back to calltracking', JSON.stringify(me.client.visibleModules) === '["calltracking"]');
    res = await get(portalJar, '/api/v1/portal/forms');
    check('after factory restore: GET /forms → 403 again', res.status === 403);

    // ---- restore owner: everything opens back up ----
    res = await patch(adminJar, `/api/v1/admin/portal-users/${userId}`, { user_type: 'owner', reset_overrides: true });
    patched = (await json(res)).data.user;
    check('restore owner: 12 tabs / 19 modules', patched.visibleTabs.length === 12 && patched.visibleModules.length === 19);
    res = await get(portalJar, '/api/v1/portal/billing');
    const billBody = await json(res);
    check('owner GET /billing → not TAB_FORBIDDEN', !(res.status === 403 && billBody.code === 'TAB_FORBIDDEN'));
    res = await get(portalJar, '/api/v1/portal/modules/chatbot');
    check('owner GET /modules/chatbot → not MODULE_FORBIDDEN', res.status === 200);

    // ---- admin endpoints are staff-only ----
    res = await post(staffJar, '/api/v1/auth/login', { email: STAFF_EMAIL, password: STAFF_PASSWORD });
    check('plain staff login 200', res.status === 200);
    res = await get(staffJar, '/api/v1/admin/portal-users');
    check('non-super staff GET /admin/portal-users → 403', res.status === 403);
    res = await get(staffJar, '/api/v1/admin/portal-access-defaults');
    check('non-super staff GET /admin/portal-access-defaults → 403', res.status === 403);
    res = await fetch(BASE + '/api/v1/admin/portal-users');
    check('anonymous GET /admin/portal-users → 401', res.status === 401);

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
