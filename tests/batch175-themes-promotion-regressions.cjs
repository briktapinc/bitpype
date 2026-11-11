'use strict';
/**
 * Batch 175 — promotion of the 20 staged themes into the live
 * registry (Ely, 2026-11-10: "i dont see the new themes in the app").
 *
 * The daily theme duty built 28 themes into ~/workspace/themes/ but
 * only the 8 launch themes were ever registered in
 * server/themesRegistry.js, so the staff Assistant rows, the Design
 * > New Design Job picker and the themes-build page (all fed by the
 * one publicCatalog()) showed just those 8. Batch 175 registers the
 * remaining 20 (recipes transcribed from each staged recipe.md) and
 * ships their thumbnails in public/themes/.
 *
 * Part 1 — registry (in-process): 28 themes, per-category counts,
 *   validateThemes() clean against the real section/module
 *   catalogs, every promoted id resolves, every thumbnail asset
 *   exists on disk as a real PNG, every promoted recipe names only
 *   real modules and carries its theme id marker.
 * Part 2 — HTTP over the real server: staff sign-in, the themes
 *   list route returns all 28 across the 8 categories (including at
 *   least two promoted themes in different categories), and a
 *   promoted theme's thumbnail serves 200 image/png. Anon is 401.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch175-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
if (process.env.DB_DRIVER === 'sqlite') {
  process.env.SQLITE_PATH = path.join(tmpRoot, 'platform.db');
  process.env.PLATFORM_DB_PATH = path.join(tmpRoot, 'platform.db');
}
process.env.WORKSPACE_DATA_DIR = path.join(tmpRoot, 'workspaces');
process.env.EXPORT_ROOT = path.join(tmpRoot, 'exports');
process.env.APP_URL = 'https://example.invalid';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.SESSION_SECRET = ['batch175', 'session', 'fixture'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root175@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Staff', '175', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B175 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3475;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`  ok ${name} (${count})`);
}

const PROMOTED = [
  'directory-v2', 'directory-v3', 'directory-v4',
  'store-v2', 'store-v3', 'store-v4',
  'services-v2', 'services-v3', 'services-v4',
  'restaurant-v2', 'restaurant-v3', 'restaurant-v4',
  'art-v2', 'art-v3', 'courses-v2', 'courses-v3',
  'events-v2', 'events-v3', 'blog-v2', 'blog-v3',
];
// Batch 179 pin update: counts rotated to the 94-theme catalog
// (the 175-era per-category counts are superseded; this suite's own
// PROMOTED set below still pins the 20 themes Batch 175 registered).
const CATEGORY_COUNTS = { directory: 12, store: 12, services: 12, restaurant: 12, art: 12, courses: 12, events: 11, blog: 11 };

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
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function main() {
  const registry = require(path.join(root, 'server/themesRegistry.js'));

  /* Part 1 — registry + assets, in-process. */
  {
    let n = 0;
    assert.deepEqual(registry.validateThemes(), [], 'registry validates clean (sections + modules parity)');
    n++;
    assert.equal(registry.THEMES.length, 94, 'registry holds all 94 themes (28 after Batch 175, 94 after Batch 179)');
    n++;
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 8, 'catalog exposes the 8 categories');
    n++;
    let total = 0;
    for (const cat of catalog) {
      assert.equal(cat.themes.length, CATEGORY_COUNTS[cat.id], `category ${cat.id} count`);
      total += cat.themes.length;
      n++;
    }
    assert.equal(total, 94, 'catalog totals 94 themes');
    n++;
    for (const id of PROMOTED) {
      const t = registry.getTheme(id);
      assert.ok(t, `promoted theme resolves: ${id}`);
      const file = path.join(root, 'public', t.thumbnail);
      assert.ok(fs.existsSync(file), `thumbnail ships: ${t.thumbnail}`);
      const buf = fs.readFileSync(file);
      assert.ok(buf.length > 10000, `thumbnail is a real screenshot (${buf.length} bytes): ${id}`);
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `thumbnail is PNG: ${id}`);
      const recipe = registry.recipeText(t);
      assert.ok(recipe.includes(`theme id: ${id}`), `recipe carries id marker: ${id}`);
      for (const m of t.pages.flatMap((p) => p.modules || [])) {
        assert.ok(registry.allowedModuleTypes().has(m), `${id} module is real: ${m}`);
      }
      n += 6;
    }
    group('Part 1 — registry: themes validate (94 after Batch 179), 175-promoted assets + recipes real', n);
  }

  /* Part 2 — HTTP over the real server. */
  {
    let n = 0;
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
          const r = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert(ready, 'server did not become ready: ' + output);

      const anon = makeJar();
      let res = await anon.fetch(`${BASE}/api/v1/assistant/themes`);
      assert.equal(res.status, 401, 'anon themes list is 401');
      n++;

      const staff = makeJar();
      res = await staff.fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD }),
      });
      assert.equal(res.status, 200, 'staff login 200');
      n++;
      // Forced MFA enrollment on first staff sign-in (Batch 154/161
      // flow, mirrored from batch171): complete enrollment so the
      // session is fully authenticated before calling staff routes.
      {
        const loginBody = await json(res.clone());
        if (loginBody.data && loginBody.data.mfaRequired && loginBody.data.mfaStage === 'enroll') {
          const totp = require(path.join(root, 'src/totp.js'));
          const start = await json(await staff.fetch(`${BASE}/api/v1/auth/mfa/enroll/start`, { method: 'POST', body: '{}' }));
          const done = await staff.fetch(`${BASE}/api/v1/auth/mfa/enroll/confirm`, {
            method: 'POST',
            body: JSON.stringify({ code: totp.totp(start.data.secret) }),
          });
          assert.equal(done.status, 200, 'MFA enroll confirm 200');
          n++;
        }
      }

      const body = await json(await staff.fetch(`${BASE}/api/v1/assistant/themes`));
      const cats = (body.data && body.data.categories) || body.categories || [];
      assert.equal(cats.length, 8, 'themes route returns 8 categories');
      n++;
      const all = cats.flatMap((c) => c.themes || []);
      assert.equal(all.length, 94, 'themes route returns all 94 themes');
      n++;
      for (const id of ['directory-v2', 'blog-v3', 'services-v4', 'restaurant-v3']) {
        assert.ok(all.some((t) => t.id === id), `themes route includes promoted ${id}`);
        n++;
      }
      res = await staff.fetch(`${BASE}/themes/blog-v3.png`);
      assert.equal(res.status, 200, 'promoted thumbnail serves 200');
      assert.match(res.headers.get('content-type') || '', /image\/png/, 'promoted thumbnail is image/png');
      await res.arrayBuffer();
      n += 2;
      group('Part 2 — HTTP: staff themes route returns 94, promoted thumbnail serves', n);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }

  console.log(`\nbatch175 themes promotion: ALL PASSED (${results.join('; ')})`);
}

main().catch((e) => {
  console.error('batch175 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
