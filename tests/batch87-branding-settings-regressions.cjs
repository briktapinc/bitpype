'use strict';
/**
 * Batch 87 — Admin branding settings (Ely 2026-10-30): the site logo
 * becomes configurable in Platform Admin — a "Logo for dark screens"
 * slot and a "Logo for light screens" slot — plus the "Local business
 * desk" tagline as an editable Admin field, with the tagline CENTERED
 * in the brand lockups (staff sidebar + auth + email header).
 *
 *   - Three platform settings in a new `branding` group:
 *     branding.logo_dark / branding.logo_light ('' = the committed
 *     default asset: public/brand/logo-white.png for dark screens,
 *     logo-black.png / logo-email.png for light) and branding.tagline
 *     (default exactly 'Local business desk'; blank falls back to the
 *     default, never renders blank). Uploaded logos are magic-byte
 *     validated (png/jpg/svg/webp, 4 MB cap), stored on the data
 *     volume under platform-brand/, and served by intercepting the
 *     canonical /brand/logo-white.png (dark) and /brand/logo-black.png
 *     + /brand/logo-email.png (light) URLs — every existing surface
 *     keeps its markup and sizing; unset/corrupt always falls back
 *     to the committed default asset.
 *   - Admin: Branding tab in Platform Admin with per-slot preview,
 *     upload/replace and reset-to-default, backed by super-admin
 *     gated GET/POST /admin/settings/branding[/logo|/logo/reset].
 *   - Consumption pinned here: staff shell brand block (serve-time
 *     tagline substitution on /app), staff auth screen (tagline via
 *     /auth/config), shared branded-email wrapper (header lockup URL
 *     unchanged; tagline + footer note read the setting), and the
 *     canonical brand URLs themselves (what portal + marketing pages
 *     reference). The tagline is centered: .brand-tag and the auth
 *     .sub carry text-align:center; the email header tagline cell is
 *     centered under the 180px logo.
 *   - Scoped out (deliberately): the mark-only logo-icon.png slots,
 *     favicon set, and og-image.png stay asset-based — a full lockup
 *     upload cannot be swapped 1:1 into mark slots.
 *
 * Harness: batch59 pattern — temp sqlite platform/workspace DBs,
 * bootstrap super admin, MFA enroll → confirm, cookie jar.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b87-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch87', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b87@example.invalid';
process.env.BOOTSTRAP_PASSWORD = 'B87-Bootstrap-Pass!23';
process.env.BOOTSTRAP_WORKSPACE = 'B87 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31487;
const BASE = `http://127.0.0.1:${PORT}`;
// 1x1 solid-red PNG — valid PNG bytes, unmistakably not the official logo.
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TEST_TAGLINE = 'Proof Desk Eighty-Seven';

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
/* Part A — source pins                                                */
/* ================================================================== */

function partA() {
  check('A1 three branding defs exist with the pinned defaults, none workspace-seeded', () => {
    const platform = require(path.join(root, 'server/platform.js'));
    const defs = Object.fromEntries(platform.PLATFORM_SETTING_DEFS.map((d) => [d.key, d]));
    for (const key of ['branding.logo_dark', 'branding.logo_light', 'branding.tagline']) {
      assert.ok(defs[key], `${key} def exists`);
      assert.equal(defs[key].group, 'branding', `${key} is in the branding group`);
    }
    assert.equal(defs['branding.logo_dark'].default, '', 'dark logo default = built-in asset (empty)');
    assert.equal(defs['branding.logo_light'].default, '', 'light logo default = built-in asset (empty)');
    assert.equal(defs['branding.logo_dark'].label, 'Logo for dark screens');
    assert.equal(defs['branding.logo_light'].label, 'Logo for light screens');
    assert.equal(defs['branding.tagline'].default, 'Local business desk', 'tagline default is exact');
    assert.ok(
      !platform.WORKSPACE_SEED_KEYS.some((k) => k.startsWith('branding.')),
      'branding keys are not workspace-seeded'
    );
  });

  check('A2 branding module: sniff accepts png/jpg/svg/webp, rejects junk; file-url validation is strict', () => {
    const b = require(path.join(root, 'server/branding.js'));
    assert.equal(b.sniffLogoMime(TEST_PNG), 'image/png');
    assert.equal(b.sniffLogoMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
    assert.equal(b.sniffLogoMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
    assert.equal(b.sniffLogoMime(Buffer.from('RIFFxxxxWEBP', 'ascii')), 'image/webp');
    assert.equal(b.sniffLogoMime(Buffer.from('definitely not an image at all')), null);
    assert.equal(b.sniffLogoMime(Buffer.from('<html><body>x</body></html>')), null, 'an HTML page is not an SVG');
    assert.equal(b.validFileUrl('/brand-files/logo-dark-1700000000000-abcdef.png'), '/brand-files/logo-dark-1700000000000-abcdef.png');
    assert.equal(b.validFileUrl('/brand-files/../secret.png'), '', 'traversal rejected');
    assert.equal(b.validFileUrl('https://evil.example/logo.png'), '', 'remote URLs rejected');
    assert.equal(b.validFileUrl(''), '');
    assert.equal(b.DEFAULT_TAGLINE, 'Local business desk');
  });

  check('A3 admin wiring: Branding tab, panel, api methods, gated routes', () => {
    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes("['branding', 'Branding']"), 'Branding settings tab');
    assert.ok(appJs.includes('brandingPanelHtml'), 'branding panel renderer');
    assert.ok(appJs.includes('Logo for dark screens') && appJs.includes('Logo for light screens'), 'Ely-facing slot labels');
    const apiJs = read('public/js/api.js');
    assert.ok(apiJs.includes("adminBranding: () => get('/admin/settings/branding')"), 'api.adminBranding');
    assert.ok(apiJs.includes('/admin/settings/branding/logo'), 'api logo upload/reset methods');
    const adminRoutes = read('server/routes/admin.js');
    assert.ok(adminRoutes.includes("router.get('/settings/branding'"), 'GET branding state route');
    assert.ok(adminRoutes.includes("router.post('/settings/branding/logo'"), 'POST logo route');
    assert.ok(adminRoutes.includes("router.post('/settings/branding/logo/reset'"), 'POST logo reset route');
    assert.ok(adminRoutes.includes("platform.audit(req.session.userId, 'branding.logo'"), 'logo writes are audited');
  });

  check('A4 consumption wiring: server interception, shell substitution, auth config, email tagline', () => {
    const serverJs = read('server.js');
    assert.ok(serverJs.includes("app.get('/brand/logo-white.png'"), 'dark brand URL intercepted');
    assert.ok(serverJs.includes("'/brand/logo-black.png', '/brand/logo-email.png'"), 'light brand URLs intercepted');
    assert.ok(serverJs.includes("require('./server/branding').tagline()"), 'shell tagline comes from the branding cache');
    assert.ok(serverJs.includes('refreshBranding'), 'branding cache primed at boot');
    const authRoutes = read('server/routes/auth.js');
    assert.ok(authRoutes.includes('tagline'), '/auth/config carries the tagline');
    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes('brandTagline'), 'staff app consumes the configured tagline');
    const tpl = read('src/emailTemplate.js');
    assert.ok(tpl.includes('branding'), 'email wrapper reads the branding cache');
    assert.ok(tpl.includes('bpTagline'), 'email tagline is setting-driven');
  });

  check('A5 tagline centered in the brand lockups (sidebar, auth, email header)', () => {
    const css = read('public/styles.css');
    const brandTag = css.match(/\.brand-tag\s*\{([^}]*)\}/);
    assert.ok(brandTag && /text-align:\s*center/.test(brandTag[1]), '.brand-tag is centered');
    const authSub = css.match(/\.auth-card \.sub\s*\{([^}]*)\}/);
    assert.ok(authSub && /text-align:\s*center/.test(authSub[1]), 'auth .sub is centered');
    const tpl = read('src/emailTemplate.js');
    assert.ok(tpl.includes('width:180px;text-align:center'), 'email header tagline centered under the 180px logo');
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
    const put = (p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
    const get = (p) => jar.fetch(BASE + p);
    const bytes = async (p) => {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 200, `${p} serves 200`);
      return Buffer.from(await r.arrayBuffer());
    };
    const defWhite = fs.readFileSync(path.join(root, 'public/brand/logo-white.png'));
    const defBlack = fs.readFileSync(path.join(root, 'public/brand/logo-black.png'));
    const defEmail = fs.readFileSync(path.join(root, 'public/brand/logo-email.png'));

    // Unauthenticated writes/reads of the branding endpoints are refused
    // (the admin router's requireAuth + requireSuperAdmin chain).
    await checkAsync('B1 unauthenticated branding access is rejected', async () => {
      let r = await fetch(`${BASE}/api/v1/admin/settings/branding`);
      assert.ok([401, 403].includes(r.status), 'GET branding state requires auth: ' + r.status);
      r = await fetch(`${BASE}/api/v1/admin/settings/branding/logo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variant: 'light', data: TEST_PNG.toString('base64') }),
      });
      assert.ok([401, 403].includes(r.status), 'POST logo requires auth: ' + r.status);
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

    await checkAsync('B3 branding state starts at the committed defaults', async () => {
      const res = await get('/api/v1/admin/settings/branding');
      const body = await json(res);
      assert.equal(res.status, 200, 'state serves 200');
      assert.equal(body.data.logoDark, '', 'dark slot empty = default');
      assert.equal(body.data.logoLight, '', 'light slot empty = default');
      assert.equal(body.data.tagline, 'Local business desk', 'tagline default');
      const all = await json(await get('/api/v1/admin/settings'));
      assert.equal(all.data.defs.find((d) => d.key === 'branding.tagline').group, 'branding', 'tagline def in the settings payload');
    });

    await checkAsync('B4 defaults served: brand URLs, staff shell tagline, auth config', async () => {
      assert.ok((await bytes('/brand/logo-white.png')).equals(defWhite), 'logo-white serves the committed default');
      assert.ok((await bytes('/brand/logo-black.png')).equals(defBlack), 'logo-black serves the committed default');
      assert.ok((await bytes('/brand/logo-email.png')).equals(defEmail), 'logo-email serves the committed default');
      const app = await (await fetch(`${BASE}/app`)).text();
      assert.ok(app.includes('<span class="brand-tag">Local business desk</span>'), 'staff shell shows the default tagline');
      const cfg = await json(await fetch(`${BASE}/api/v1/auth/config`));
      assert.equal(cfg.data.tagline, 'Local business desk', 'auth config carries the default tagline');
    });

    await checkAsync('B5 email wrapper renders the default tagline (header + footer note)', async () => {
      const branding = require(path.join(root, 'server/branding.js'));
      await branding.refreshBranding();
      const tpl = require(path.join(root, 'src/emailTemplate.js'));
      const { html } = tpl.renderBrandedEmail({ title: 'B87', paragraphs: ['x'] });
      assert.ok(html.includes('>Local business desk</div>'), 'header tagline is the default');
      assert.ok(html.includes('Bitpype · Local business desk'), 'footer note is the default');
      assert.ok(html.includes('src="https://bitpype.test/brand/logo-email.png"'), 'header img still the canonical email lockup URL');
    });

    await checkAsync('B6 custom light logo: upload → canonical light URLs serve it; dark untouched', async () => {
      const res = await post('/api/v1/admin/settings/branding/logo', { variant: 'light', data: TEST_PNG.toString('base64') });
      const body = await json(res);
      assert.equal(res.status, 200, 'upload accepted: ' + JSON.stringify(body));
      assert.ok(/^\/brand-files\/logo-light-\d+-[a-z0-9]{6}\.png$/.test(body.data.url), 'stored path shape: ' + body.data.url);
      assert.ok((await bytes('/brand/logo-email.png')).equals(TEST_PNG), 'logo-email serves the custom logo');
      assert.ok((await bytes('/brand/logo-black.png')).equals(TEST_PNG), 'logo-black serves the custom logo');
      assert.ok((await bytes('/brand/logo-white.png')).equals(defWhite), 'dark slot still the default');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoLight, body.data.url, 'state reports the custom light logo');
    });

    await checkAsync('B7 upload validation: non-images and bad variants are coded 400s', async () => {
      let res = await post('/api/v1/admin/settings/branding/logo', { variant: 'light', data: Buffer.from('not an image').toString('base64') });
      let body = await json(res);
      assert.equal(res.status, 400, 'junk bytes rejected');
      assert.equal(body.code, 'BAD_LOGO_TYPE', 'coded BAD_LOGO_TYPE: ' + JSON.stringify(body));
      res = await post('/api/v1/admin/settings/branding/logo', { variant: 'sideways', data: TEST_PNG.toString('base64') });
      body = await json(res);
      assert.equal(res.status, 400, 'bad variant rejected');
      assert.ok((await bytes('/brand/logo-email.png')).equals(TEST_PNG), 'failed uploads changed nothing');
    });

    await checkAsync('B8 custom tagline flows to the staff shell, auth config, and email', async () => {
      const res = await put('/api/v1/admin/settings', { settings: { 'branding.tagline': TEST_TAGLINE } });
      assert.equal(res.status, 200, 'tagline saved via the generic settings PUT');
      const app = await (await fetch(`${BASE}/app`)).text();
      assert.ok(app.includes(`<span class="brand-tag">${TEST_TAGLINE}</span>`), 'staff shell serves the custom tagline');
      const cfg = await json(await fetch(`${BASE}/api/v1/auth/config`));
      assert.equal(cfg.data.tagline, TEST_TAGLINE, 'auth config serves the custom tagline');
      const branding = require(path.join(root, 'server/branding.js'));
      await branding.refreshBranding();
      delete require.cache[require.resolve(path.join(root, 'src/emailTemplate.js'))];
      const tpl = require(path.join(root, 'src/emailTemplate.js'));
      const { html } = tpl.renderBrandedEmail({ title: 'B87', paragraphs: ['x'], footerNote: null });
      assert.ok(html.includes(`>${TEST_TAGLINE}</div>`), 'email header serves the custom tagline');
      assert.ok(html.includes(`Bitpype · ${TEST_TAGLINE}`), 'email footer note serves the custom tagline');
      // over-long taglines are rejected by the choke point
      const bad = await put('/api/v1/admin/settings', { settings: { 'branding.tagline': 'x'.repeat(200) } });
      assert.equal(bad.status, 400, 'over-long tagline rejected');
      // a hand-set logo path that the upload path never minted is rejected too
      const badLogo = await put('/api/v1/admin/settings', { settings: { 'branding.logo_light': 'https://evil.example/x.png' } });
      assert.equal(badLogo.status, 400, 'foreign logo path rejected');
    });

    await checkAsync('B9 reset restores the defaults and removes the stored file', async () => {
      const res = await post('/api/v1/admin/settings/branding/logo/reset', { variant: 'light' });
      assert.equal(res.status, 200, 'reset accepted');
      assert.ok((await bytes('/brand/logo-email.png')).equals(defEmail), 'logo-email serves the official default again');
      const dir = path.join(temp, 'workspaces', 'platform-brand');
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('logo-light-')) : [];
      assert.equal(leftovers.length, 0, 'stored custom file removed on reset');
      const blank = await put('/api/v1/admin/settings', { settings: { 'branding.tagline': '' } });
      assert.equal(blank.status, 200, 'blank tagline saves (means: use default)');
      const app = await (await fetch(`${BASE}/app`)).text();
      assert.ok(app.includes('<span class="brand-tag">Local business desk</span>'), 'blank tagline falls back to the default, never blank');
      const state = await json(await get('/api/v1/admin/settings/branding'));
      assert.equal(state.data.logoLight, '', 'state back to default');
      assert.equal(state.data.tagline, 'Local business desk', 'state tagline back to default');
    });

    await checkAsync('B10 corrupt stored values fall back to the defaults, never break rendering', async () => {
      // A hand-edited DB row (bypassing the choke point) can hold junk;
      // the cache layer must read it as unset.
      await db.query("INSERT OR REPLACE INTO platform_settings (`key`, value) VALUES ('branding.logo_light', '/etc/passwd')");
      const branding = require(path.join(root, 'server/branding.js'));
      await branding.refreshBranding();
      assert.equal(branding.customLogoPath('light'), '', 'corrupt value reads as unset');
      assert.equal(branding.customLogoFile('light'), null, 'corrupt value yields no file');
      assert.ok((await bytes('/brand/logo-email.png')).equals(defEmail), 'served logo stays the default');
      await platform.setPlatformSetting('branding.logo_light', '');
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
  console.log(`batch87 branding-settings checks passed (${results.length}):`);
  for (const r of results) console.log('  - ' + r);
})().catch((e) => {
  console.error('batch87 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
