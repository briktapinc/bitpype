'use strict';
/**
 * Batch 195 — Admin Training video re-upload / replace.
 * Boots the real server (sqlite or MySQL via REGRESSION_DB_DRIVER)
 * and drives it over HTTP:
 *   upload a different module's video over module 2 (main + mobile)
 *     → the canonical /training/ URL serves the NEW bytes (full GET
 *     byte-compare + Range 206), the file lands on the DATA volume
 *     (WORKSPACE_DATA_DIR/training-videos/...), the baked public/
 *     file is untouched, and a second replace leaves no orphans.
 *   invalid type → 400 INVALID_VIDEO, oversized → 400 TOO_LARGE,
 *     empty → 400, bad slot → 400, unauthenticated → 401/403, and
 *     the served video is unchanged after every rejection.
 *   Batch 194 behavior intact: URL-edit PATCH still works, the
 *     student still sees exactly [training, packages] and the
 *     training list carries the canonical video URL.
 *   restore: uploading the original bytes back returns the served
 *     bytes to the seeded original.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpype-b195-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.SESSION_SECRET = 'b195-suite-secret-0123456789abcdef';
process.env.NODE_ENV = 'production';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const PORT = 31495;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, cond) {
  assert(cond, name);
  results.push(name);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const STUDENT_EMAIL = 'student195@example.invalid';
const PORTAL_PASSWORD = 'PortalPass195!';
const ADMIN_EMAIL = 'admin195@example.invalid';
const ADMIN_PASSWORD = 'AdminPass195!';

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
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const hash = (pw) => bcrypt.hashSync(pw, 12);

  await db.query('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
    e: ADMIN_EMAIL,
    h: hash(ADMIN_PASSWORD),
    n: 'Fixture Admin',
    s: 'active',
  });
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb
    .prepare('INSERT INTO leads (id, business_name, email, status) VALUES (601, ?, ?, ?)')
    .run('Student Biz', STUDENT_EMAIL, 'lead');
  const r = await db.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
     VALUES (:e, :h, 1, 601, 'Fixture', 'active', 'student')`,
    { e: STUDENT_EMAIL, h: hash(PORTAL_PASSWORD) }
  );
  check('seeded student portal user', Number(r.insertId) > 0);

  // fixture bytes: the seeded originals + a visibly different donor
  const origMain = fs.readFileSync(path.join(root, 'public/training/02-signing-in.mp4'));
  const origMobile = fs.readFileSync(path.join(root, 'public/training-mobile/02-signing-in.mp4'));
  const donorMain = fs.readFileSync(path.join(root, 'public/training/03-finding-your-way-around.mp4'));
  const donorMobile = fs.readFileSync(path.join(root, 'public/training-mobile/03-finding-your-way-around.mp4'));
  check('donor differs from original', sha(donorMain) !== sha(origMain) && sha(donorMobile) !== sha(origMobile));

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
        const rr = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
        if (rr.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((res2) => setTimeout(res2, 200));
    }
    assert(ready, 'server did not become ready: ' + output);

    const adminJar = makeJar();
    const studentJar = makeJar();
    const anonJar = makeJar();
    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (jar, p, headers) => jar.fetch(BASE + p, { headers });
    const patch = (jar, p, body) => jar.fetch(BASE + p, { method: 'PATCH', body: JSON.stringify(body || {}) });
    const fetchBuf = async (p, headers) => Buffer.from(await (await fetch(BASE + p, { headers })).arrayBuffer());

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

    // ---- admin session + target module ----
    let res = await post(adminJar, '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    check('staff admin login 200', res.status === 200);
    await completeStaffMfa(adminJar, res);
    res = await get(adminJar, '/api/v1/admin/training-modules');
    const modules = ((await json(res)).data || {}).modules || [];
    check('admin list: 17 seeded modules', modules.length === 17);
    const target = modules.find((m) => m.slug === '02-signing-in');
    check('target module 02-signing-in present', !!target);
    const MAIN_URL = '/training/02-signing-in.mp4';
    const MOBILE_URL = '/training-mobile/02-signing-in.mp4';
    check(
      'target URLs are the canonical seeded paths',
      target.videoUrl === MAIN_URL && target.videoMobileUrl === MOBILE_URL
    );

    // baseline: the seeded bytes are what the URLs serve
    check('baseline main serves seeded bytes', sha(await fetchBuf(MAIN_URL)) === sha(origMain));
    check('baseline mobile serves seeded bytes', sha(await fetchBuf(MOBILE_URL)) === sha(origMobile));

    const upload = (jar, id, body) => post(jar, `/api/v1/admin/training-modules/${id}/video`, body);
    const b64 = (buf) => buf.toString('base64');

    // ---- unauthenticated upload is refused ----
    res = await upload(anonJar, target.id, { slot: 'main', dataBase64: b64(donorMain) });
    check('unauthenticated upload refused (401/403)', res.status === 401 || res.status === 403);
    check('served bytes unchanged after unauth attempt', sha(await fetchBuf(MAIN_URL)) === sha(origMain));

    // ---- replace MAIN with the donor video ----
    res = await upload(adminJar, target.id, { slot: 'main', dataBase64: b64(donorMain) });
    const upBody = await json(res);
    check('main upload 200', res.status === 200);
    check('main upload returns canonical url', upBody.data && upBody.data.url === MAIN_URL);
    check(
      'main upload module.videoUrl canonical',
      upBody.data && upBody.data.module && upBody.data.module.videoUrl === MAIN_URL
    );
    check('main: served bytes are the donor now', sha(await fetchBuf(MAIN_URL)) === sha(donorMain));
    const range = await fetch(BASE + MAIN_URL, { headers: { Range: 'bytes=0-99' } });
    const rangeBuf = Buffer.from(await range.arrayBuffer());
    check(
      'main: Range request 206 with donor slice',
      range.status === 206 && rangeBuf.equals(donorMain.subarray(0, 100))
    );
    const storedMain = path.join(temp, 'workspaces', 'training-videos', 'main', '02-signing-in.mp4');
    check(
      'main: file stored on the data volume',
      fs.existsSync(storedMain) && sha(fs.readFileSync(storedMain)) === sha(donorMain)
    );
    check(
      'main: baked public file untouched',
      sha(fs.readFileSync(path.join(root, 'public/training/02-signing-in.mp4'))) === sha(origMain)
    );

    // ---- replace MOBILE with the donor mobile video ----
    res = await upload(adminJar, target.id, { slot: 'mobile', dataBase64: b64(donorMobile) });
    check('mobile upload 200', res.status === 200 && (await json(res)).data.url === MOBILE_URL);
    check('mobile: served bytes are the donor now', sha(await fetchBuf(MOBILE_URL)) === sha(donorMobile));

    // ---- a second replace leaves exactly one file, no tmp orphans ----
    res = await upload(adminJar, target.id, { slot: 'main', dataBase64: b64(origMain) });
    check('second main upload (restore bytes) 200', res.status === 200);
    const mainDirFiles = fs.readdirSync(path.join(temp, 'workspaces', 'training-videos', 'main'));
    check('no orphan/tmp files after replaces', JSON.stringify(mainDirFiles) === '["02-signing-in.mp4"]');
    check('main: served bytes restored to original', sha(await fetchBuf(MAIN_URL)) === sha(origMain));

    // ---- validation: every rejection leaves the served video alone ----
    const pngBuf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      crypto.randomBytes(2048),
    ]);
    res = await upload(adminJar, target.id, { slot: 'main', dataBase64: b64(pngBuf) });
    let rejBody = await json(res);
    check('PNG upload → 400 INVALID_VIDEO', res.status === 400 && rejBody.code === 'INVALID_VIDEO');
    check('served bytes unchanged after invalid type', sha(await fetchBuf(MAIN_URL)) === sha(origMain));

    const textBuf = Buffer.from('this is not a video at all, just text bytes for the suite');
    res = await upload(adminJar, target.id, { slot: 'mobile', dataBase64: b64(textBuf) });
    rejBody = await json(res);
    check('text upload → 400 INVALID_VIDEO', res.status === 400 && rejBody.code === 'INVALID_VIDEO');
    check('mobile bytes unchanged after invalid type', sha(await fetchBuf(MOBILE_URL)) === sha(donorMobile));

    res = await upload(adminJar, target.id, { slot: 'main' });
    rejBody = await json(res);
    check('empty upload → 400 EMPTY', res.status === 400 && rejBody.code === 'EMPTY');

    res = await upload(adminJar, target.id, { slot: 'sideways', dataBase64: b64(donorMain) });
    rejBody = await json(res);
    check('bad slot → 400 INVALID', res.status === 400 && rejBody.code === 'INVALID');

    const big = Buffer.alloc(50 * 1024 * 1024 + 1);
    big.writeUInt32BE(24, 0);
    big.write('ftyp', 4, 'ascii');
    big.write('isom', 8, 'ascii');
    res = await upload(adminJar, target.id, { slot: 'main', dataBase64: b64(big) });
    rejBody = await json(res);
    check('oversized (cap+1, valid ftyp) → 400 TOO_LARGE', res.status === 400 && rejBody.code === 'TOO_LARGE');
    check('served bytes unchanged after oversize', sha(await fetchBuf(MAIN_URL)) === sha(origMain));

    res = await upload(adminJar, 999999, { slot: 'main', dataBase64: b64(donorMain) });
    check('unknown module → 404', res.status === 404);

    // ---- Batch 194 behavior: URL edit still works ----
    res = await patch(adminJar, `/api/v1/admin/training-modules/${target.id}`, {
      videoUrl: '/training/01-welcome-to-your-portal.mp4',
    });
    check(
      'URL-edit PATCH 200',
      res.status === 200 && (await json(res)).data.module.videoUrl === '/training/01-welcome-to-your-portal.mp4'
    );
    res = await patch(adminJar, `/api/v1/admin/training-modules/${target.id}`, { videoUrl: MAIN_URL });
    check('URL-edit restore 200', res.status === 200 && (await json(res)).data.module.videoUrl === MAIN_URL);

    // ---- Batch 194 behavior: the student view is unchanged ----
    res = await post(studentJar, '/api/v1/portal/login', { email: STUDENT_EMAIL, password: PORTAL_PASSWORD });
    check('student portal login 200', res.status === 200);
    const me = (await json(await get(studentJar, '/api/v1/portal/me'))).data;
    check(
      'student /me tabs exactly [training, packages]',
      JSON.stringify(me.client.visibleTabs) === '["training","packages"]'
    );
    res = await get(studentJar, '/api/v1/portal/training');
    const trainBody = await json(res);
    const listed = (trainBody.data.modules || []).find((m) => m.id === target.id);
    check(
      'student training list carries canonical URLs',
      !!listed && listed.videoUrl === MAIN_URL && listed.videoMobileUrl === MOBILE_URL
    );

    // ---- restore mobile to the seeded original ----
    res = await upload(adminJar, target.id, { slot: 'mobile', dataBase64: b64(origMobile) });
    check('mobile restore upload 200', res.status === 200);
    check('mobile: served bytes restored to original', sha(await fetchBuf(MOBILE_URL)) === sha(origMobile));

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
