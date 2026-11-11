'use strict';
/**
 * Batch 179 — promotion of the remaining 66 staged themes into the
 * live registry (Ely, 2026-11-11: "Add them to the app").
 *
 * The daily theme duty plus Ely's 2026-11-11 bonus (24) and variety
 * (32) batches built 86 staged themes into ~/workspace/themes/;
 * Batch 175 registered the first 20, so the staff Assistant rows,
 * the Design > New Design Job picker and the themes-build page (all
 * fed by the one publicCatalog()) showed 28. Batch 179 registers
 * the remaining 66 (recipes transcribed from each staged recipe.md,
 * Batch 175 conventions) and ships their thumbnails in
 * public/themes/<id>.png. The catalog now holds 94 themes.
 *
 * Part 1 — registry (in-process): 94 themes, per-category counts,
 *   category order with the launch theme leading each row,
 *   validateThemes() clean against the real section/module
 *   catalogs, every promoted id resolves, every thumbnail asset
 *   exists on disk as a real PNG, every promoted recipe names only
 *   real modules and carries its theme id marker, and the
 *   publicCatalog() shape (pages/modules/recipe per theme) holds
 *   for the new entries.
 * Part 2 — HTTP over the real server: staff sign-in, the themes
 *   list route returns all 94 across the 8 categories (including
 *   newly promoted themes in several categories), and two promoted
 *   themes' thumbnails serve 200 image/png. Anon is 401.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch179-'));
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
process.env.SESSION_SECRET = ['batch179', 'session', 'fixture'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root179@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Staff', '179', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B179 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3479;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`  ok ${name} (${count})`);
}

const PROMOTED = [
  'directory-v5', 'directory-v6', 'directory-v7', 'directory-v8', 'directory-v9', 'directory-v10', 'directory-v11', 'directory-v12',
  'store-v5', 'store-v6', 'store-v7', 'store-v8', 'store-v9', 'store-v10', 'store-v11', 'store-v12',
  'services-v5', 'services-v6', 'services-v7', 'services-v8', 'services-v9', 'services-v10', 'services-v11', 'services-v12',
  'restaurant-v5', 'restaurant-v6', 'restaurant-v7', 'restaurant-v8', 'restaurant-v9', 'restaurant-v10', 'restaurant-v11', 'restaurant-v12',
  'art-v4', 'art-v5', 'art-v6', 'art-v7', 'art-v8', 'art-v9', 'art-v10', 'art-v11', 'art-v12',
  'courses-v4', 'courses-v5', 'courses-v6', 'courses-v7', 'courses-v8', 'courses-v9', 'courses-v10', 'courses-v11', 'courses-v12',
  'events-v4', 'events-v5', 'events-v6', 'events-v7', 'events-v8', 'events-v9', 'events-v10', 'events-v11',
  'blog-v4', 'blog-v5', 'blog-v6', 'blog-v7', 'blog-v8', 'blog-v9', 'blog-v10', 'blog-v11',
];
const CATEGORY_ORDER = ['directory', 'store', 'services', 'restaurant', 'art', 'courses', 'events', 'blog'];
const CATEGORY_COUNTS = { directory: 12, store: 12, services: 12, restaurant: 12, art: 12, courses: 12, events: 11, blog: 11 };
const LAUNCH_FIRST = {
  directory: 'directory-classic', store: 'store-northwind', services: 'services-summit',
  restaurant: 'restaurant-olive-ember', art: 'art-mara-voss', courses: 'courses-brightpath',
  events: 'events-gatherwell', blog: 'blog-daily-field',
};

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
    assert.equal(registry.THEMES.length, 94, 'registry holds all 94 themes');
    n++;
    assert.equal(PROMOTED.length, 66, 'batch promotes exactly 66 themes');
    n++;
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 8, 'catalog exposes the 8 categories');
    n++;
    assert.deepEqual(catalog.map((c) => c.id), CATEGORY_ORDER, 'catalog category order is directory..blog');
    n++;
    let total = 0;
    for (const cat of catalog) {
      assert.equal(cat.themes.length, CATEGORY_COUNTS[cat.id], `category ${cat.id} count`);
      assert.equal(cat.themes[0].id, LAUNCH_FIRST[cat.id], `category ${cat.id} leads with its launch theme`);
      const nums = cat.themes.slice(1).map((t) => Number((t.id.match(/-v(\d+)$/) || [])[1] || 0));
      assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `category ${cat.id} variants in numeric order`);
      total += cat.themes.length;
      n += 3;
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
      assert.ok(recipe.includes('THEME LAYOUT GUIDE'), `recipe is a layout guide: ${id}`);
      for (const m of t.pages.flatMap((p) => p.modules || [])) {
        assert.ok(registry.allowedModuleTypes().has(m), `${id} module is real: ${m}`);
      }
      for (const s of t.pages.flatMap((p) => p.sections || [])) {
        assert.ok(registry.allowedSectionTypes().has(s), `${id} section is real: ${s}`);
      }
      n += 7;
    }
    // publicCatalog() shape for new entries: pages are names, modules
    // are the deduped union, recipe is the full layout-guide text.
    for (const id of ['directory-v5', 'services-v11', 'art-v10', 'courses-v12', 'events-v8', 'blog-v11']) {
      const cat = catalog.find((c) => c.themes.some((t) => t.id === id));
      const pub = cat.themes.find((t) => t.id === id);
      assert.ok(Array.isArray(pub.pages) && pub.pages[0] === 'Home', `${id} public pages shape`);
      assert.ok(Array.isArray(pub.modules) && pub.modules.length > 0, `${id} public modules shape`);
      assert.ok(typeof pub.recipe === 'string' && pub.recipe.includes(`theme id: ${id}`), `${id} public recipe shape`);
      n += 3;
    }
    group('Part 1 — registry: 94 themes validate, promoted assets + recipes real', n);
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
      // flow, mirrored from batch175): complete enrollment so the
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
      for (const id of ['directory-v12', 'store-v9', 'services-v6', 'restaurant-v12', 'art-v10', 'courses-v9', 'events-v11', 'blog-v11']) {
        assert.ok(all.some((t) => t.id === id), `themes route includes promoted ${id}`);
        n++;
      }
      for (const id of ['directory-v5', 'blog-v11']) {
        res = await staff.fetch(`${BASE}/themes/${id}.png`);
        assert.equal(res.status, 200, `promoted thumbnail serves 200: ${id}`);
        assert.match(res.headers.get('content-type') || '', /image\/png/, `promoted thumbnail is image/png: ${id}`);
        await res.arrayBuffer();
        n += 2;
      }
      group('Part 2 — HTTP: staff themes route returns 94, promoted thumbnails serve', n);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }

  console.log(`\nbatch179 themes promotion: ALL PASSED (${results.join('; ')})`);
}

main().catch((e) => {
  console.error('batch179 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
