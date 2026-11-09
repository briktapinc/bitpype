'use strict';
/**
 * Batch 169 — Assistant page Themes section + Build wizard.
 *
 * Ely's order (2026-11-09): a "Themes" section on the portal
 * Assistant page — themes by website category, thumbnails in
 * per-category horizontally scrollable rows, a "Build this" button
 * per theme opening a wizard popup (select or add a lead + theme
 * details) whose Build creates a real design job using the theme as
 * the layout guide. HARD RULE: themes use ONLY existing BitPype
 * modules/sections — no invented components.
 *
 * Part 1 — registry validity (in-process): the catalog validates
 *   against the REAL catalogs (MODULE_TYPES in server/siteModules.js,
 *   pinned at 31; section types from src/siteStructure.js), one
 *   theme per category at launch, thumbnail files ship in
 *   public/themes/, recipes carry the theme id.
 * Part 2 — service level: buildWithTheme creates a real design job
 *   through designJobs.createJob for an existing lead (job fields,
 *   dedupe refresh), creates a lead through leadEngine on the
 *   new-lead path, and surfaces NOT_FOUND / VALIDATION /
 *   DUPLICATE_EMAIL errors.
 * Part 3 — HTTP over the real server: anonymous refusals, catalog +
 *   lead search shapes, wizard build end-to-end (existing lead,
 *   new lead), error surfacing (unknown lead 404, unknown theme
 *   400, duplicate email 409), static thumbnail serving.
 * Part 4 — source pins: the Themes block sits below the chat in
 *   sec-assistant, the wizard markup exists, portal.js talks to the
 *   three routes, the batch adds ZERO SEC-13 census sinks (the
 *   census stays 503 / 379 safe — all new DOM is createElement).
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch169-'));
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
process.env.SESSION_SECRET = ['batch169', 'regression', 'secret'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root169@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Root', '169', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B169 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3473;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`  ok ${name} (${count})`);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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

async function main() {
  const registry = require(path.join(root, 'server/themesRegistry.js'));

  /* ================================================================
   * Part 1 — registry validity against the real catalogs.
   * ================================================================ */
  {
    let n = 0;
    assert.deepEqual(registry.validateThemes(), [], 'registry validates clean against the real section/module catalogs');
    n++;
    const { MODULE_TYPES } = require(path.join(root, 'server/siteModules.js'));
    assert.equal(MODULE_TYPES.length, 31, 'MODULE_TYPES pin: still 31 (Batch 169 adds no module type)');
    assert.equal(registry.allowedModuleTypes().size, 31, 'registry module allowlist is the real 31');
    n += 2;
    assert.deepEqual(
      [...registry.allowedSectionTypes()].sort(),
      ['about', 'banner', 'benefits', 'cards', 'columns', 'cta', 'faq', 'footer', 'gallery', 'heading', 'hero', 'html', 'image', 'nav', 'reviews', 'services', 'text', 'text_image'],
      'section allowlist = the 15 layout content types + nav/banner/footer chrome (18)'
    );
    n++;
    assert.equal(registry.CATEGORIES.length, 8, 'eight categories at launch');
    assert.equal(registry.THEMES.length, 8, 'one theme per category at launch');
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 8, 'public catalog exposes all eight categories');
    assert.equal(catalog[0].label, 'Directory', 'first category is Directory');
    for (const cat of catalog) {
      assert.equal(cat.themes.length, 1, `category ${cat.id} has its launch theme`);
      const t = cat.themes[0];
      assert.ok(t.id && t.name && t.tagline && t.thumbnail, `theme ${t.id} carries id/name/tagline/thumbnail`);
      assert.ok(Array.isArray(t.pages) && t.pages.length >= 3, `theme ${t.id} lists its pages`);
      assert.ok(Array.isArray(t.modules) && t.modules.length >= 1, `theme ${t.id} names real modules`);
      const file = path.join(root, 'public', t.thumbnail);
      assert.ok(fs.existsSync(file) && fs.statSync(file).size > 10000, `thumbnail asset ships at ${t.thumbnail}`);
      n += 5;
    }
    const recipe = registry.recipeText(registry.getTheme('services-summit'));
    assert.ok(recipe.includes('theme id: services-summit'), 'recipe carries the theme id marker');
    assert.ok(recipe.includes('estimate'), 'services recipe names the estimate module');
    assert.ok(recipe.includes('LAYOUT GUIDE ONLY'), 'recipe states the layout-guide doctrine');
    n += 3;
    // A tampered registry must fail validation (invented names refused).
    const tampered = JSON.parse(JSON.stringify(registry.THEMES));
    tampered[0].pages[0].sections.push('magic_carousel');
    tampered[0].pages[0].modules.push('hologram');
    const problems = registry.validateThemes(tampered);
    assert.ok(problems.some((p) => p.includes('magic_carousel')), 'invented section type fails validation');
    assert.ok(problems.some((p) => p.includes('hologram')), 'invented module type fails validation');
    n += 2;
    group('Part 1 — registry validity, catalog pins', n);
  }

  /* ================================================================
   * Fixtures (workspace 1 leads, mirroring batch161).
   * ================================================================ */
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('Fixture Plants LLC', 'owner169@example.invalid', 'customer');
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)').run('Second Biz', 'second169@example.invalid', 'customer');

  /* ================================================================
   * Part 2 — service level: buildWithTheme.
   * ================================================================ */
  {
    let n = 0;
    const built = registry.buildWithTheme(wdb, {
      themeId: 'services-summit',
      leadId: 501,
      businessName: 'Fixture Plants LLC',
      siteShape: 'multipage',
      pagesWanted: 'Home, Services, Book a Visit, Contact',
      brandNotes: 'Deep green and cream.',
    });
    assert.ok(built.job && built.job.id, 'job created through designJobs.createJob');
    assert.equal(built.job.type, 'website', 'job type is website');
    assert.equal(built.job.lead_id, 501, 'job is attached to the chosen lead');
    assert.equal(built.job.site_shape, 'multipage', 'job carries the wizard site shape');
    assert.equal(built.job.status, 'waiting_on_agent', 'job lands staged in the design queue');
    assert.ok(built.job.instructions.includes('theme id: services-summit'), 'job instructions carry the theme recipe (theme id marker)');
    assert.ok(built.job.instructions.includes('Deep green and cream.'), 'job instructions carry the wizard brand notes');
    assert.ok(built.job.instructions.includes('Pages wanted: Home, Services'), 'job instructions carry the wizard pages');
    assert.ok(built.job.title.includes('Fixture Plants LLC'), 'job title names the business');
    assert.equal(built.leadId, 501, 'service returns the resolved lead id');
    n += 10;

    // The platform createJob flow dedupes an open job per lead+type:
    // a second wizard build for the same lead refreshes that job.
    const rebuilt = registry.buildWithTheme(wdb, {
      themeId: 'directory-classic',
      leadId: 501,
      siteShape: 'landing',
    });
    assert.equal(rebuilt.job.id, built.job.id, 'second build for the same lead refreshes the open job (shared createJob dedupe)');
    assert.ok(rebuilt.job.instructions.includes('theme id: directory-classic'), 'refreshed job carries the new theme recipe');
    n += 2;

    // New-lead path: the lead is created through the lead engine,
    // then the job attaches to it.
    const fresh = registry.buildWithTheme(wdb, {
      themeId: 'restaurant-olive-ember',
      newLead: { businessName: 'Wizard Test Bistro', category: 'Restaurant', city: 'Reading', email: 'bistro169@example.invalid', phone: '555-0169' },
      siteShape: 'multipage',
    });
    assert.ok(fresh.leadId > 0 && fresh.leadId !== 501 && fresh.leadId !== 777, 'new lead created');
    const leadRow = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(fresh.leadId);
    assert.equal(leadRow.business_name, 'Wizard Test Bistro', 'lead row persisted with the wizard business name');
    assert.equal(leadRow.city, 'Reading', 'lead row persisted with the wizard city');
    assert.equal(fresh.job.lead_id, fresh.leadId, 'job attaches to the new lead');
    n += 4;

    // Error surfacing.
    assert.throws(
      () => registry.buildWithTheme(wdb, { themeId: 'services-summit', leadId: 424242 }),
      (e) => e.code === 'NOT_FOUND',
      'a lead id outside the workspace is NOT_FOUND'
    );
    assert.throws(
      () => registry.buildWithTheme(wdb, { themeId: 'no-such-theme', leadId: 501 }),
      (e) => e.code === 'VALIDATION',
      'an unknown theme is VALIDATION'
    );
    assert.throws(
      () => registry.buildWithTheme(wdb, { themeId: 'services-summit' }),
      (e) => e.code === 'VALIDATION',
      'no lead and no new-lead payload is VALIDATION'
    );
    assert.throws(
      () =>
        registry.buildWithTheme(wdb, {
          themeId: 'blog-daily-field',
          newLead: { businessName: 'Copycat News', email: 'owner169@example.invalid' },
        }),
      (e) => e.code === 'DUPLICATE_EMAIL',
      'a duplicate lead email surfaces the lead engine DUPLICATE_EMAIL error'
    );
    n += 4;
    group('Part 2 — buildWithTheme service level', n);
  }

  /* ================================================================
   * Part 3 — HTTP over the real server.
   * ================================================================ */
  {
    let n = 0;
    const bcrypt = require('bcryptjs');
    const db = require(path.join(root, 'server/db.js'));
    await db.migrate();
    const portalHash = bcrypt.hashSync(['Portal', '169', 'Pass'].join('-'), 12);
    if (db.driver() === 'mysql') {
      await db.query('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (:e, :h, 1, 501, :b, :s)', {
        e: 'owner169@example.invalid',
        h: portalHash,
        b: 'Fixture Plants LLC',
        s: 'active',
      });
      await db.query('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (:e, :h, 1, 777, :b, :s)', {
        e: 'second169@example.invalid',
        h: portalHash,
        b: 'Second Biz',
        s: 'active',
      });
    } else {
      const RawDb = require('better-sqlite3');
      const raw = new RawDb(process.env.SQLITE_PATH);
      raw
        .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?, ?, 1, 501, ?, ?)')
        .run('owner169@example.invalid', portalHash, 'Fixture Plants LLC', 'active');
      raw
        .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?, ?, 1, 777, ?, ?)')
        .run('second169@example.invalid', portalHash, 'Second Biz', 'active');
      raw.close();
    }

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

      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      const get = (jar, p) => jar.fetch(BASE + p);

      // Anonymous refusals on all three routes.
      const anon = makeJar();
      let res = await get(anon, '/api/v1/portal/assistant/themes');
      assert.ok(res.status === 401 || res.status === 403, 'themes catalog refuses anonymous');
      res = await get(anon, '/api/v1/portal/assistant/themes/leads');
      assert.ok(res.status === 401 || res.status === 403, 'themes lead search refuses anonymous');
      res = await post(anon, '/api/v1/portal/assistant/themes/build', { themeId: 'services-summit', leadId: 501 });
      assert.ok(res.status === 401 || res.status === 403, 'themes build refuses anonymous');
      n += 3;

      // Portal sign-in.
      const portalJar = makeJar();
      res = await post(portalJar, '/api/v1/portal/login', { email: 'owner169@example.invalid', password: ['Portal', '169', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'portal login 200');
      n++;

      // Catalog shape.
      const catalogBody = await json(await get(portalJar, '/api/v1/portal/assistant/themes'));
      assert.ok(catalogBody.ok && catalogBody.data, 'catalog responds ok');
      const cats = catalogBody.data.categories;
      assert.equal(cats.length, 8, 'catalog has the eight categories');
      assert.deepEqual(
        cats.map((c) => c.id),
        ['directory', 'store', 'services', 'restaurant', 'art', 'courses', 'events', 'blog'],
        'categories arrive in registry order'
      );
      const services = cats.find((c) => c.id === 'services');
      assert.equal(services.themes[0].id, 'services-summit', 'services theme id served');
      assert.equal(services.themes[0].thumbnail, '/themes/services.png', 'services thumbnail path served');
      assert.ok(services.themes[0].modules.includes('estimate'), 'services theme modules include estimate');
      n += 6;

      // Lead search.
      const searchBody = await json(await get(portalJar, '/api/v1/portal/assistant/themes/leads?q=Fixture'));
      assert.ok((searchBody.data.leads || []).some((l) => l.id === 501), 'lead search finds Fixture Plants LLC');
      const allBody = await json(await get(portalJar, '/api/v1/portal/assistant/themes/leads'));
      assert.ok((allBody.data.leads || []).some((l) => l.id === 777), 'unfiltered lead list includes Second Biz');
      const noneBody = await json(await get(portalJar, '/api/v1/portal/assistant/themes/leads?q=zzz-no-match'));
      assert.equal((noneBody.data.leads || []).length, 0, 'a non-matching search returns an empty list');
      n += 3;

      // Wizard build — existing lead (777 keeps it distinct from the
      // Part 2 in-process jobs on lead 501).
      const buildBody = await json(
        await post(portalJar, '/api/v1/portal/assistant/themes/build', {
          themeId: 'store-northwind',
          leadId: 777,
          businessName: 'Second Biz',
          siteShape: 'multipage',
          brandNotes: 'Warm oak and cream.',
        })
      );
      assert.ok(buildBody.ok && buildBody.data && buildBody.data.jobId, `wizard build returns a job id (${JSON.stringify(buildBody).slice(0, 200)})`);
      assert.equal(buildBody.data.leadId, 777, 'build response names the lead');
      assert.equal(buildBody.data.themeId, 'store-northwind', 'build response names the theme');
      assert.equal(buildBody.data.status, 'waiting_on_agent', 'build response: job staged waiting_on_agent');
      const jobRow = wdb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(buildBody.data.jobId);
      assert.ok(jobRow, 'the design job row exists in the workspace db');
      assert.equal(jobRow.lead_id, 777, 'job row attached to lead 777');
      assert.ok(jobRow.instructions.includes('theme id: store-northwind'), 'job row instructions carry the theme recipe');
      n += 7;

      // Wizard build — new lead path over HTTP.
      const freshBody = await json(
        await post(portalJar, '/api/v1/portal/assistant/themes/build', {
          themeId: 'blog-daily-field',
          newLead: { businessName: 'HTTP Test Gazette', city: 'Fleetwood', email: 'gazette169@example.invalid' },
        })
      );
      assert.ok(freshBody.ok && freshBody.data.jobId, 'new-lead wizard build returns a job id');
      assert.ok(freshBody.data.leadId > 0, 'new-lead build returns the created lead id');
      const afterBody = await json(await get(portalJar, '/api/v1/portal/assistant/themes/leads?q=Gazette'));
      assert.ok((afterBody.data.leads || []).some((l) => l.id === freshBody.data.leadId), 'the created lead is findable in lead search');
      n += 3;

      // Error surfacing in the popup contract ({ok:false,error}).
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', { themeId: 'store-northwind', leadId: 424242 });
      assert.equal(res.status, 404, 'unknown lead -> 404');
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', { themeId: 'no-such-theme', leadId: 501 });
      assert.equal(res.status, 400, 'unknown theme -> 400');
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', { themeId: 'store-northwind' });
      assert.equal(res.status, 400, 'no lead chosen -> 400');
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', {
        themeId: 'blog-daily-field',
        newLead: { businessName: 'Copycat', email: 'second169@example.invalid' },
      });
      assert.equal(res.status, 409, 'duplicate lead email -> 409');
      const errBody = await json(res);
      assert.ok(errBody.ok === false && errBody.error, 'error body carries a message for the popup');
      n += 5;

      // The second portal user (lead 777) can use the section too.
      const portalJar2 = makeJar();
      res = await post(portalJar2, '/api/v1/portal/login', { email: 'second169@example.invalid', password: ['Portal', '169', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'second portal login 200');
      const cats2 = await json(await get(portalJar2, '/api/v1/portal/assistant/themes'));
      assert.equal((cats2.data.categories || []).length, 8, 'second portal user gets the catalog');
      n += 2;

      // Thumbnails are served as static assets.
      res = await fetch(`${BASE}/themes/services.png`);
      assert.equal(res.status, 200, 'thumbnail asset serves 200');
      assert.ok(String(res.headers.get('content-type') || '').includes('image/png'), 'thumbnail serves as image/png');
      n += 2;
    } finally {
      child.kill('SIGKILL');
      await closed.catch(() => {});
    }
    group('Part 3 — HTTP routes, wizard build, errors', n);
  }

  /* ================================================================
   * Part 4 — source pins.
   * ================================================================ */
  {
    let n = 0;
    const portalHtml = read('public/portal.html');
    const layoutAt = portalHtml.indexOf('class="assistant-layout"');
    const themesAt = portalHtml.indexOf('id="themes-block"');
    assert.ok(layoutAt > -1 && themesAt > layoutAt, 'Themes block renders below the assistant chat layout');
    assert.ok(portalHtml.includes('id="theme-wizard-backdrop"'), 'wizard popup markup exists');
    assert.ok(portalHtml.includes('id="tw-lead-select"'), 'wizard has the lead picker');
    assert.ok(portalHtml.includes('id="tw-new-name"'), 'wizard has the new-lead fields');
    assert.ok(portalHtml.includes('id="tw-build"'), 'wizard has the Build button');
    assert.ok(portalHtml.includes('.themes-row'), 'portal styles include the scrollable category rows');
    assert.ok(portalHtml.includes('--bp-space-card-gap'), 'row gap uses the shared card-gap token');
    n += 7;

    const portalJs = read('public/js/portal.js');
    const marker = portalJs.indexOf('// Batch 169');
    assert.ok(marker > -1, 'portal.js carries the Batch 169 block');
    const block = portalJs.slice(marker);
    assert.ok(block.includes("api('/assistant/themes')"), 'portal.js loads the catalog route');
    assert.ok(block.includes('/assistant/themes/leads?q='), 'portal.js searches leads via the route');
    assert.ok(block.includes("api('/assistant/themes/build'"), 'portal.js builds via the route');
    assert.ok(block.includes("'Build this'"), 'theme cards render a Build this button');
    assert.ok(!block.includes('innerHTML'), 'Batch 169 portal.js block adds no innerHTML sink (createElement + textContent only)');
    n += 6;

    const routes = read('server/routes/portal.js');
    assert.ok(routes.includes("router.get('/assistant/themes'"), 'catalog route registered');
    assert.ok(routes.includes("router.get('/assistant/themes/leads'"), 'lead search route registered');
    assert.ok(routes.includes("router.post('/assistant/themes/build'"), 'build route registered');
    n += 3;

    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.equal(cz.summary.total, 503, 'SEC-13 census total unchanged by Batch 169 (zero new sinks)');
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 379, 'SEC-13 safe classes unchanged by Batch 169');
    assert.equal(cz.summary.RAW, 86, 'SEC-13 RAW unchanged');
    assert.equal(cz.summary.IDENT, 38, 'SEC-13 IDENT unchanged');
    n += 4;
    group('Part 4 — source pins, zero new census sinks', n);
  }

  console.log(`\nbatch169 themes wizard: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main().catch((e) => {
  console.error('batch169 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
