'use strict';
/**
 * Batch 169 — Themes registry + buildWithTheme service (shared core).
 * Batch 172 — the portal Themes section + wizard REMOVED (Ely,
 *   2026-11-09: "Remove it from portal" — Themes is staff-only now).
 *
 * History: Batch 169 shipped a "Themes" section on the portal
 * Assistant page — themes by website category, thumbnails in
 * per-category horizontally scrollable rows, a "Build this" button
 * per theme opening a wizard popup whose Build created a real
 * design job using the theme as the layout guide. Batch 172 removes
 * that portal surface (markup, JS, routes) while KEEPING the shared
 * core — server/themesRegistry.js and the public/themes/ thumbnails —
 * because the staff app (Batch 171) uses them.
 *
 * Part 1 — registry validity (in-process): the catalog validates
 *   against the REAL catalogs (MODULE_TYPES in server/siteModules.js,
 *   pinned at 31; section types from src/siteStructure.js), one
 *   theme per category at launch, thumbnail files ship in
 *   public/themes/, recipes carry the theme id. [169, unchanged]
 * Part 2 — service level: buildWithTheme creates a real design job
 *   through designJobs.createJob for an existing lead (job fields,
 *   dedupe refresh), creates a lead through leadEngine on the
 *   new-lead path, and surfaces NOT_FOUND / VALIDATION /
 *   DUPLICATE_EMAIL errors. [169, unchanged — the staff batch
 *   depends on this service]
 * Part 3 — HTTP over the real server [172, NEGATIVE]: the three
 *   portal themes routes are GONE (indistinguishable from an
 *   unknown route for a signed-in portal client — this platform
 *   answers unknown /api/v1/portal/* paths with 401 AUTH_REQUIRED,
 *   not 404 — and a build attempt creates no job), while the
 *   shared thumbnail assets still serve.
 * Part 4 — source pins [172, NEGATIVE]: no Themes block, wizard
 *   markup, themes JS or themes routes remain in the portal files;
 *   the assistant chat itself is untouched; the batch adds ZERO
 *   SEC-13 census sinks (census 504 / 380 safe on the merged
 *   tree after the Batch 168 rebase — the +1 STATIC is 168's).
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
// Batch 168 rebase fixture: the server refuses to boot in
// production without SETTINGS_ENCRYPTION_KEY (168's S1#3 boot
// assert) — the spawned child inherits this synthetic key, the
// same Buffer.alloc(32, 23) base64 fixture the other real-server
// suites use. Not a real secret.
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
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
    assert.equal(MODULE_TYPES.length, 32, 'MODULE_TYPES pin: still 31 (Batch 169 adds no module type) (Batch 178: leads_router the 32nd — pin rotated)');
    assert.equal(registry.allowedModuleTypes().size, 32, 'registry module allowlist is the real 31 (Batch 178: 32 with leads_router — pin rotated)');
    n += 2;
    assert.deepEqual(
      [...registry.allowedSectionTypes()].sort(),
      ['about', 'banner', 'benefits', 'cards', 'columns', 'cta', 'faq', 'footer', 'gallery', 'heading', 'hero', 'html', 'image', 'nav', 'reviews', 'services', 'text', 'text_image'],
      'section allowlist = the 15 layout content types + nav/banner/footer chrome (18)'
    );
    n++;
    assert.equal(registry.CATEGORIES.length, 8, 'eight categories at launch');
    // Batch 175 pin update: the 20 staged themes were promoted into the
    // registry (28 total), so the launch-era "one theme per category"
    // pin is superseded — the launch theme now leads each category row.
    // Batch 179 pin update: the remaining 66 staged themes were promoted
    // (94 total) — the launch theme still leads each category row.
    assert.equal(registry.THEMES.length, 94, 'registry holds the 8 launch + 86 promoted themes (Batches 175 + 179)');
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 8, 'public catalog exposes all eight categories');
    assert.equal(catalog[0].label, 'Directory', 'first category is Directory');
    for (const cat of catalog) {
      assert.ok(cat.themes.length >= 1, `category ${cat.id} has its launch theme`);
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
   * Part 3 — HTTP over the real server. [Batch 172 NEGATIVE]
   * The portal themes routes were removed: they must be
   * indistinguishable from an unknown route for a signed-in
   * portal client, a build attempt must create nothing, and the
   * shared thumbnail assets (kept for the staff app) must still
   * serve. NOTE on the expected status: this platform has no 404
   * for unknown /api/v1/portal/* paths — an unmatched portal path
   * falls through to the /api/v1 domainApi chain and dies at
   * requireWorkspace with 401 AUTH_REQUIRED (verified against a
   * nonsense path in this very part). The pin is therefore
   * "identical status to an unknown route", which is what
   * "removed" observably means here.
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

      // Portal sign-in still works (the removal touched nothing else).
      const portalJar = makeJar();
      let res = await post(portalJar, '/api/v1/portal/login', { email: 'owner169@example.invalid', password: ['Portal', '169', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'portal login 200');
      n++;

      // Job count before the build attempts (Part 2 created jobs
      // in-process on this same workspace db).
      const jobsBefore = wdb.prepare('SELECT COUNT(*) AS c FROM design_jobs').get().c;

      // Baseline: what does a definitely-unknown portal route
      // answer for this same signed-in client? (Platform answer:
      // 401 AUTH_REQUIRED from the /api/v1 fall-through chain.)
      res = await get(portalJar, '/api/v1/portal/assistant/widgets-nope-172');
      const unknownStatus = res.status;
      assert.ok(unknownStatus === 401 || unknownStatus === 404, `unknown portal route baseline is the platform not-found answer (${unknownStatus})`);
      n++;

      // The three Batch 169 portal routes are GONE — each answers
      // EXACTLY like that unknown route, with no catalog data.
      res = await get(portalJar, '/api/v1/portal/assistant/themes');
      assert.equal(res.status, unknownStatus, 'themes catalog route removed (answers like an unknown route)');
      const goneBody = await json(res);
      assert.ok(!(goneBody.data && goneBody.data.categories), 'catalog response carries no categories');
      res = await get(portalJar, '/api/v1/portal/assistant/themes/leads?q=Fixture');
      assert.equal(res.status, unknownStatus, 'themes lead search route removed (answers like an unknown route)');
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', { themeId: 'services-summit', leadId: 501 });
      assert.equal(res.status, unknownStatus, 'themes build route removed (answers like an unknown route)');
      res = await post(portalJar, '/api/v1/portal/assistant/themes/build', {
        themeId: 'blog-daily-field',
        newLead: { businessName: 'HTTP Test Gazette', city: 'Fleetwood', email: 'gazette169@example.invalid' },
      });
      assert.equal(res.status, unknownStatus, 'themes build (new-lead payload) also answers like an unknown route');
      n += 5;

      // The removed build route creates nothing: no job, no lead.
      const jobsAfter = wdb.prepare('SELECT COUNT(*) AS c FROM design_jobs').get().c;
      assert.equal(jobsAfter, jobsBefore, 'removed build route created no design job');
      const gazette = wdb.prepare('SELECT COUNT(*) AS c FROM leads WHERE business_name = ?').get('HTTP Test Gazette').c;
      assert.equal(gazette, 0, 'removed build route created no lead');
      n += 2;

      // Anonymous callers get no catalog either (route does not exist).
      const anon = makeJar();
      res = await get(anon, '/api/v1/portal/assistant/themes');
      assert.ok(res.status === 404 || res.status === 401 || res.status === 403, 'themes catalog does not answer anonymous');
      n++;

      // Shared thumbnail assets are KEPT (the staff app serves them).
      res = await fetch(`${BASE}/themes/services.png`);
      assert.equal(res.status, 200, 'thumbnail asset still serves 200 (kept for staff)');
      assert.ok(String(res.headers.get('content-type') || '').includes('image/png'), 'thumbnail still serves as image/png');
      n += 2;
    } finally {
      child.kill('SIGKILL');
      await closed.catch(() => {});
    }
    group('Part 3 — HTTP: portal themes routes removed (unknown-route parity), assets kept', n);
  }

  /* ================================================================
   * Part 4 — source pins. [Batch 172 NEGATIVE]
   * ================================================================ */
  {
    let n = 0;
    const portalHtml = read('public/portal.html');
    assert.ok(!portalHtml.includes('id="themes-block"'), 'Themes block markup removed from portal.html');
    assert.ok(!portalHtml.includes('id="themes-catalog"'), 'themes catalog container removed');
    assert.ok(!portalHtml.includes('id="theme-wizard-backdrop"'), 'wizard popup markup removed');
    assert.ok(!portalHtml.includes('id="tw-lead-select"'), 'wizard lead picker removed');
    assert.ok(!portalHtml.includes('.themes-row'), 'themes row styles removed');
    assert.ok(!portalHtml.includes('.theme-card'), 'theme card styles removed');
    assert.ok(!portalHtml.includes('.theme-wizard'), 'wizard styles removed');
    assert.ok(portalHtml.includes('.assistant-layout'), 'assistant chat layout intact (removal touched nothing else)');
    n += 8;

    const portalJs = read('public/js/portal.js');
    assert.ok(!portalJs.includes('// Batch 169'), 'portal.js Batch 169 block removed');
    assert.ok(!portalJs.includes('/assistant/themes'), 'portal.js no longer calls any themes route');
    assert.ok(!portalJs.includes('themes-block'), 'portal.js holds no themes section code');
    assert.ok(portalJs.includes('loadAssistant'), 'assistant chat loader intact');
    assert.ok(portalJs.includes("api('/assistant/conversations')"), 'assistant chat API calls intact');
    n += 5;

    const routes = read('server/routes/portal.js');
    assert.ok(!routes.includes('/assistant/themes'), 'no themes routes registered in portal router');
    assert.ok(!routes.includes('themesRegistry'), 'portal router no longer references the themes registry');
    n += 2;

    assert.ok(fs.existsSync(path.join(root, 'server/themesRegistry.js')), 'shared registry kept on disk for the staff app');
    n++;

    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    // Batch 174 RE-PIN: the tree census is 506 / IDENT 41 — Batch
    // 174's design-chat redesign added exactly three IDENT
    // assistantMd(...) writes in portal.js (multiset-proven in
    // the Batch 174 suite). Batch 169's own movement stays zero;
    // RAW and safe classes are unchanged.
    assert.equal(cz.summary.total, 518, 'SEC-13 census total (Batch 174 re-pin — see note above)');
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 387, 'SEC-13 safe classes (Batch 176 re-pin: +1 STATIC from the pageAssistant shell reclassification — see batch103) unchanged (379)');
    assert.equal(cz.summary.RAW, 88, 'SEC-13 RAW (Batch 176 re-pin: pageAssistant shell RAW -> STATIC — see batch103)');
    assert.equal(cz.summary.IDENT, 43, 'SEC-13 IDENT (Batch 174 re-pin — see note above)');
    n += 4;
    group('Part 4 — source pins: portal surface gone, core kept, census stable', n);
  }

  console.log(`\nbatch169/172 themes core + portal removal: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main().catch((e) => {
  console.error('batch169 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
