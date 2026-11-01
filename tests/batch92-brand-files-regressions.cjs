'use strict';
/**
 * Batch 92 — /brand-files serving + branding missing-file honesty
 * (Ely 2026-10-30, screenshot: both Admin → Settings → Branding
 * previews rendered broken-image placeholders while the copy claimed
 * "A custom logo is in use.").
 *
 * Diagnosis (hash-proven live before the fix): Ely's logos uploaded
 * and persisted fine on the data volume, and the canonical brand
 * URLs (/brand/logo-white.png, /brand/logo-black.png) served his
 * exact uploaded bytes — his branding was LIVE on every real
 * surface. The break was preview-only: the settings panel's <img>
 * src is the stored path `/brand-files/<filename>`, which Batch 87
 * minted as "the served path" but no route ever mounted, so the
 * previews 404'd.
 *
 * Fix pinned here:
 *   - server.js serves GET /brand-files/:name from the data volume
 *     via branding.storedLogoFile (minted filenames only; anything
 *     else 404s) with the brand routes' headers.
 *   - brandingState() carries logoDarkMissing / logoLightMissing:
 *     configured-but-file-gone is reported honestly, and the
 *     settings panel previews the built-in default with a
 *     "file is missing" note instead of a broken image under a
 *     "custom logo is in use" claim.
 *
 * Harness: batch87 pattern — temp sqlite platform/workspace DBs,
 * bootstrap super admin, MFA enroll → confirm, cookie jar.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b92-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch92', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b92@example.invalid';
process.env.BOOTSTRAP_PASSWORD = [process.env.BOOTSTRAP_PASSWORD, 'Batch92', 'Test', 'Pw'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B92 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31492;
const BASE = `http://127.0.0.1:${PORT}`;
// 1x1 solid-red PNG — valid PNG bytes, unmistakably not the official logo.
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ================================================================== */
/* Part A — source pins + storedLogoFile unit behaviour                */
/* ================================================================== */

function partA() {
  check('A1 server.js mounts /brand-files/:name via branding.storedLogoFile', () => {
    const serverJs = read('server.js');
    assert.ok(serverJs.includes("app.get('/brand-files/:name'"), 'route mounted');
    assert.ok(serverJs.includes('storedLogoFile'), 'route resolves through storedLogoFile');
  });

  check('A2 brandingState carries the missing-file honesty flags; panel consumes them', () => {
    const branding = read('server/branding.js');
    assert.ok(branding.includes('logoDarkMissing'), 'state has logoDarkMissing');
    assert.ok(branding.includes('logoLightMissing'), 'state has logoLightMissing');
    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes('state.logoDarkMissing') && appJs.includes('state.logoLightMissing'), 'panel passes the flags to the slots');
    assert.ok(appJs.includes('its file is missing'), 'panel has the honest missing-file copy');
    assert.ok(appJs.includes('current && !missing ? current : fallbackUrl'), 'missing slot previews the built-in default, never the broken path');
  });

  check('A3 storedLogoFile: minted names only, live existence, content types', () => {
    const b = require(path.join(root, 'server/branding.js'));
    assert.equal(typeof b.storedLogoFile, 'function', 'storedLogoFile exported');
    const dir = path.join(temp, 'workspaces', 'platform-brand');
    fs.mkdirSync(dir, { recursive: true });
    // Distinct names from Part B's probes, and removed afterwards —
    // Part B boots a server over this same temp data dir.
    const name = 'logo-dark-1600000000001-fedcba.png';
    const svgName = 'logo-light-1600000000001-fedcba.svg';
    assert.equal(b.storedLogoFile(name), null, 'well-formed but absent file → null');
    fs.writeFileSync(path.join(dir, name), TEST_PNG);
    const hit = b.storedLogoFile(name);
    assert.ok(hit && hit.contentType === 'image/png', 'present file resolves with image/png');
    assert.ok(fs.readFileSync(hit.file).equals(TEST_PNG), 'resolves to the stored bytes');
    assert.equal(b.storedLogoFile('../secret.png'), null, 'traversal rejected');
    assert.equal(b.storedLogoFile('logo-white.png'), null, 'non-minted name rejected');
    assert.equal(b.storedLogoFile('logo-dark-1600000000001-fedcba.exe'), null, 'bad extension rejected');
    assert.equal(b.storedLogoFile(''), null, 'empty rejected');
    assert.equal(b.storedLogoFile(null), null, 'null rejected');
    fs.writeFileSync(path.join(dir, svgName), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.equal(b.storedLogoFile(svgName).contentType, 'image/svg+xml', 'svg content type');
    fs.unlinkSync(path.join(dir, name));
    fs.unlinkSync(path.join(dir, svgName));
    // customLogoFile still behaves (refactor guard)
    assert.equal(b.customLogoFile('dark'), null, 'no setting configured in this process → null');
  });
}

/* ================================================================== */
/* Part B — booted server                                              */
/* ================================================================== */

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, { ...opts, headers });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const pair = String(sc).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

async function partB() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');

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

    const jar = makeJar();
    const post = (p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (p) => jar.fetch(BASE + p);
    const defWhite = fs.readFileSync(path.join(root, 'public/brand/logo-white.png'));
    const defBlack = fs.readFileSync(path.join(root, 'public/brand/logo-black.png'));

    await checkAsync('B1 /brand-files refuses everything that is not a stored minted file', async () => {
      let r = await fetch(`${BASE}/brand-files/logo-dark-1700000000000-abcdef.png`);
      assert.equal(r.status, 404, 'well-formed but missing file → 404');
      r = await fetch(`${BASE}/brand-files/logo-white.png`);
      assert.equal(r.status, 404, 'non-minted name → 404 (never the default asset under this prefix)');
      r = await fetch(`${BASE}/brand-files/..%2f..%2fserver.js`);
      assert.equal(r.status, 404, 'encoded traversal → 404');
      r = await fetch(`${BASE}/brand-files/logo-dark-1700000000000-abcdef.exe`);
      assert.equal(r.status, 404, 'bad extension → 404');
    });

    // Bootstrap super-admin session (Batch 40 flow: login → enroll → confirm).
    {
      const totp = require(path.join(root, 'src/totp.js'));
      let res = await post('/api/v1/auth/login', { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD });
      let body = await json(res);
      assert(res.status === 200 && body.data.mfaRequired === true && body.data.mfaStage === 'enroll', 'login parks at MFA enroll');
      res = await post('/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      assert(body.data.secret, 'enroll secret issued');
      res = await post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(body.data.secret) });
      body = await json(res);
      assert(res.status === 200 && body.data.user, 'session issued');
    }
    check('B2 super-admin session established', () => {});

    await checkAsync('B3 state starts at defaults with honesty flags present and false', async () => {
      const body = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(body.data.logoDark, '', 'dark slot empty = default');
      assert.equal(body.data.logoLight, '', 'light slot empty = default');
      assert.equal(body.data.logoDarkMissing, false, 'logoDarkMissing present, false');
      assert.equal(body.data.logoLightMissing, false, 'logoLightMissing present, false');
    });

    let darkUrl = '';
    let darkFile = '';
    await checkAsync('B4 upload dark logo → the stored /brand-files path SERVES it (the Batch 87 gap)', async () => {
      const res = await post('/api/v1/admin/settings/branding/logo', { variant: 'dark', data: TEST_PNG.toString('base64') });
      const body = await json(res);
      assert.equal(res.status, 200, 'upload accepted: ' + JSON.stringify(body));
      darkUrl = body.data.url;
      assert.ok(/^\/brand-files\/logo-dark-\d+-[a-z0-9]{6}\.png$/.test(darkUrl), 'stored path shape: ' + darkUrl);
      darkFile = path.join(temp, 'workspaces', 'platform-brand', darkUrl.slice('/brand-files/'.length));
      assert.ok(fs.existsSync(darkFile), 'file stored on the data volume');
      // Exactly what the settings preview does: a plain unauthenticated <img> GET.
      const img = await fetch(BASE + darkUrl);
      assert.equal(img.status, 200, 'preview URL serves 200 (was 404 before the fix)');
      assert.equal(img.headers.get('content-type'), 'image/png', 'preview URL serves the image content type');
      assert.ok(Buffer.from(await img.arrayBuffer()).equals(TEST_PNG), 'preview URL serves the uploaded bytes');
      const canon = await fetch(`${BASE}/brand/logo-white.png`);
      assert.ok(Buffer.from(await canon.arrayBuffer()).equals(TEST_PNG), 'canonical dark URL serves the custom logo too');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoDark, darkUrl, 'state reports the custom dark logo');
      assert.equal(state.data.logoDarkMissing, false, 'state honestly reports the file present');
    });

    await checkAsync('B5 NEGATIVE PROOF — file deleted: route 404s, canonical falls back, state flags missing', async () => {
      const saved = fs.readFileSync(darkFile);
      fs.unlinkSync(darkFile);
      const img = await fetch(BASE + darkUrl);
      assert.equal(img.status, 404, 'missing file → the preview path 404s (no stale bytes)');
      const canon = await fetch(`${BASE}/brand/logo-white.png`);
      assert.ok(Buffer.from(await canon.arrayBuffer()).equals(defWhite), 'canonical URL falls back to the built-in default — never a broken reference');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoDark, darkUrl, 'slot is still configured (the setting was not silently wiped)');
      assert.equal(state.data.logoDarkMissing, true, 'state surfaces the discrepancy: logoDarkMissing === true');
      fs.writeFileSync(darkFile, saved);
      const state2 = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state2.data.logoDarkMissing, false, 'restoring the file clears the flag');
      const img2 = await fetch(BASE + darkUrl);
      assert.equal(img2.status, 200, 'restored file serves again');
    });

    await checkAsync('B6 light slot serves under /brand-files too; defaults elsewhere untouched', async () => {
      const res = await post('/api/v1/admin/settings/branding/logo', { variant: 'light', data: TEST_PNG.toString('base64') });
      const body = await json(res);
      assert.equal(res.status, 200, 'light upload accepted');
      const img = await fetch(BASE + body.data.url);
      assert.equal(img.status, 200, 'light preview URL serves 200');
      assert.ok(Buffer.from(await img.arrayBuffer()).equals(TEST_PNG), 'light preview URL serves the uploaded bytes');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoLightMissing, false, 'light file present');
    });

    await checkAsync('B7 reset removes the stored file and its /brand-files URL dies with it', async () => {
      let res = await post('/api/v1/admin/settings/branding/logo/reset', { variant: 'dark' });
      assert.equal(res.status, 200, 'dark reset accepted');
      const img = await fetch(BASE + darkUrl);
      assert.equal(img.status, 404, 'reset slot: the old stored path 404s');
      res = await post('/api/v1/admin/settings/branding/logo/reset', { variant: 'light' });
      assert.equal(res.status, 200, 'light reset accepted');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoDark, '', 'dark back to default');
      assert.equal(state.data.logoLight, '', 'light back to default');
      assert.equal(state.data.logoDarkMissing, false, 'no missing claim on a default slot');
      const canon = await fetch(`${BASE}/brand/logo-black.png`);
      assert.ok(Buffer.from(await canon.arrayBuffer()).equals(defBlack), 'canonical light URL serves the default again');
    });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/* ================================================================== */

(async () => {
  partA();
  await partB();
  console.log(`batch92 brand-files checks passed (${results.length}):`);
  for (const r of results) console.log('  - ' + r);
})().catch((e) => {
  console.error('batch92 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
