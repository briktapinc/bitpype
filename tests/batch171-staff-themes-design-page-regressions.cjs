'use strict';
/**
 * Batch 171 — Themes in the STAFF app + New Design Job page.
 *
 * Ely's orders (2026-11-09): Batch 169 shipped Themes portal-only
 * and Ely could not see them in the staff app — "Add Themes to the
 * staff app too"; themes ALSO belong in Design > New Design Job,
 * and "Make new design job its own page" (the Batch 153 popup
 * becomes a dedicated page carrying its exact behaviour plus a
 * theme picker).
 *
 * Part 1 — registry touch: publicCatalog() themes now carry the
 *   exact recipe text (recipeText) so page-created jobs carry the
 *   same recipe markers as wizard-built ones; registry validity
 *   and the Batch 169 pins are untouched.
 * Part 2 — HTTP over the real server, staff surface: anonymous
 *   refusals, a PORTAL session is refused on the staff routes
 *   (assistantStaffOnly is session-only), staff sign-in, catalog
 *   order + recipe payload, lead search semantics (incl. LIKE
 *   escaping), wizard build end-to-end (existing + new lead) into
 *   a waiting_on_agent job with recipe markers, error contract
 *   (404 / 400 / 400 / 409 with {ok:false,error}).
 * Part 3 — UI source pins + behaviour units: the Themes card sits
 *   in pageAssistant and mounts; the wizard lives in app.js on the
 *   staff api client; the New Design Job page is routed
 *   (PAGES + ROUTE_LABELS), the Design list's New button and the
 *   old openNewDesignModal name both land on #/design-new, the
 *   popup body is gone; theme-block helpers are eval'd out of
 *   app.js and exercised (pick / switch / remove never touch
 *   hand-typed text; type-change composition with designTypeFill
 *   preserves the block verbatim); ZERO new SEC-13 census sinks;
 *   portal files keep their Batch 169 surface (removal is Batch
 *   172's job, not this one's).
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch171-'));
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
process.env.SESSION_SECRET = ['batch171', 'regression', 'secret'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root171@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Root', '171', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B171 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3481;
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
   * Part 1 — the one registry touch: catalog carries recipe text.
   * ================================================================ */
  {
    let n = 0;
    assert.deepEqual(registry.validateThemes(), [], 'registry still validates clean');
    n++;
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 8, 'catalog still exposes the eight categories');
    for (const cat of catalog) {
      for (const t of cat.themes) {
        assert.equal(typeof t.recipe, 'string', `theme ${t.id} catalog entry carries recipe text`);
        assert.equal(t.recipe, registry.recipeText(registry.getTheme(t.id)), `theme ${t.id} recipe equals recipeText(theme)`);
        assert.ok(t.recipe.includes(`theme id: ${t.id}`), `theme ${t.id} recipe carries the id marker`);
        n += 3;
      }
    }
    group('Part 1 — catalog recipe payload', n);
  }

  /* ================================================================
   * Fixtures (workspace 1 leads + a portal user, mirroring 169).
   * ================================================================ */
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('Fixture Plants LLC', 'owner171@example.invalid', 'customer');
  wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)').run('Second Biz', 'second171@example.invalid', 'customer');

  /* ================================================================
   * Part 2 — HTTP over the real server (staff surface).
   * ================================================================ */
  {
    let n = 0;
    const bcrypt = require('bcryptjs');
    const db = require(path.join(root, 'server/db.js'));
    await db.migrate();
    const portalHash = bcrypt.hashSync(['Portal', '171', 'Pass'].join('-'), 12);
    if (db.driver() === 'mysql') {
      await db.query('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (:e, :h, 1, 501, :b, :s)', {
        e: 'owner171@example.invalid',
        h: portalHash,
        b: 'Fixture Plants LLC',
        s: 'active',
      });
    } else {
      const RawDb = require('better-sqlite3');
      const raw = new RawDb(process.env.SQLITE_PATH);
      raw
        .prepare('INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status) VALUES (?, ?, 1, 501, ?, ?)')
        .run('owner171@example.invalid', portalHash, 'Fixture Plants LLC', 'active');
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

      // Anonymous refusals on all three staff themes routes.
      const anon = makeJar();
      let res = await get(anon, '/api/v1/assistant/themes');
      assert.ok(res.status === 401 || res.status === 403, 'staff themes catalog refuses anonymous');
      res = await get(anon, '/api/v1/assistant/themes/leads');
      assert.ok(res.status === 401 || res.status === 403, 'staff themes lead search refuses anonymous');
      res = await post(anon, '/api/v1/assistant/themes/build', { themeId: 'services-summit', leadId: 501 });
      assert.ok(res.status === 401 || res.status === 403, 'staff themes build refuses anonymous');
      n += 3;

      // A portal session is NOT a staff session: refused here.
      const portalJar = makeJar();
      res = await post(portalJar, '/api/v1/portal/login', { email: 'owner171@example.invalid', password: ['Portal', '171', 'Pass'].join('-') });
      assert.equal(res.status, 200, 'portal login 200 (fixture sanity)');
      res = await get(portalJar, '/api/v1/assistant/themes');
      assert.ok(res.status === 401 || res.status === 403, 'portal session refused on the staff themes catalog');
      res = await post(portalJar, '/api/v1/assistant/themes/build', { themeId: 'services-summit', leadId: 501 });
      assert.ok(res.status === 401 || res.status === 403, 'portal session refused on the staff themes build');
      n += 3;

      // Staff sign-in (+ forced MFA enrollment, mirroring batch161).
      const totp = require(path.join(root, 'src/totp.js'));
      const staffJar = makeJar();
      res = await post(staffJar, '/api/v1/auth/login', {
        email: process.env.BOOTSTRAP_EMAIL,
        password: ['Root', '171', 'Pass'].join('-'),
      });
      let loginBody = await json(res);
      assert.equal(res.status, 200, `staff login 200 (got ${res.status}: ${JSON.stringify(loginBody).slice(0, 200)})`);
      if (loginBody.data && loginBody.data.mfaRequired) {
        if (loginBody.data.mfaStage === 'enroll') {
          const start = await json(await post(staffJar, '/api/v1/auth/mfa/enroll/start', {}));
          const done = await post(staffJar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
          loginBody = await json(done);
        }
      }
      n += 1;

      // Catalog shape + order + recipe payload.
      const catalogBody = await json(await get(staffJar, '/api/v1/assistant/themes'));
      assert.ok(catalogBody.ok && catalogBody.data, 'staff catalog responds ok');
      const cats = catalogBody.data.categories;
      assert.equal(cats.length, 8, 'staff catalog has the eight categories');
      assert.deepEqual(
        cats.map((c) => c.id),
        ['directory', 'store', 'services', 'restaurant', 'art', 'courses', 'events', 'blog'],
        'staff catalog categories arrive in registry order'
      );
      const services = cats.find((c) => c.id === 'services');
      assert.equal(services.themes[0].id, 'services-summit', 'services theme id served on staff route');
      assert.equal(services.themes[0].thumbnail, '/themes/services.png', 'services thumbnail path served on staff route');
      assert.ok(String(services.themes[0].recipe).includes('theme id: services-summit'), 'staff catalog theme carries the recipe text (page picker payload)');
      n += 6;

      // Lead search semantics.
      const searchBody = await json(await get(staffJar, '/api/v1/assistant/themes/leads?q=Fixture'));
      assert.ok((searchBody.data.leads || []).some((l) => l.id === 501), 'staff lead search finds Fixture Plants LLC');
      const allBody = await json(await get(staffJar, '/api/v1/assistant/themes/leads'));
      assert.ok((allBody.data.leads || []).some((l) => l.id === 777), 'staff unfiltered lead list includes Second Biz');
      const noneBody = await json(await get(staffJar, '/api/v1/assistant/themes/leads?q=zzz-no-match'));
      assert.equal((noneBody.data.leads || []).length, 0, 'staff non-matching search returns an empty list');
      const pctBody = await json(await get(staffJar, '/api/v1/assistant/themes/leads?q=%25'));
      assert.equal((pctBody.data.leads || []).length, 0, 'a bare % search is LIKE-escaped, not a wildcard dump');
      n += 4;

      // Wizard build — existing lead.
      const buildBody = await json(
        await post(staffJar, '/api/v1/assistant/themes/build', {
          themeId: 'store-northwind',
          leadId: 777,
          businessName: 'Second Biz',
          siteShape: 'multipage',
          brandNotes: 'Warm oak and cream.',
        })
      );
      assert.ok(buildBody.ok && buildBody.data && buildBody.data.jobId, `staff wizard build returns a job id (${JSON.stringify(buildBody).slice(0, 200)})`);
      assert.equal(buildBody.data.leadId, 777, 'staff build response names the lead');
      assert.equal(buildBody.data.themeId, 'store-northwind', 'staff build response names the theme');
      assert.equal(buildBody.data.status, 'waiting_on_agent', 'staff build response: job staged waiting_on_agent');
      const jobRow = wdb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(buildBody.data.jobId);
      assert.ok(jobRow, 'the design job row exists in the workspace db');
      assert.equal(jobRow.lead_id, 777, 'job row attached to lead 777');
      assert.equal(jobRow.status, 'waiting_on_agent', 'job row staged waiting_on_agent');
      assert.ok(jobRow.instructions.includes('theme id: store-northwind'), 'job row instructions carry the theme recipe');
      n += 8;

      // Wizard build — new lead path over HTTP.
      const freshBody = await json(
        await post(staffJar, '/api/v1/assistant/themes/build', {
          themeId: 'blog-daily-field',
          newLead: { businessName: 'Staff Test Gazette', city: 'Fleetwood', email: 'gazette171@example.invalid' },
        })
      );
      assert.ok(freshBody.ok && freshBody.data.jobId, 'staff new-lead wizard build returns a job id');
      assert.ok(freshBody.data.leadId > 0, 'staff new-lead build returns the created lead id');
      const afterBody = await json(await get(staffJar, '/api/v1/assistant/themes/leads?q=Gazette'));
      assert.ok((afterBody.data.leads || []).some((l) => l.id === freshBody.data.leadId), 'the created lead is findable in staff lead search');
      n += 3;

      // New Design Job page, end-to-end at the API the page calls:
      // instructions composed exactly as the page composes them —
      // type instructions + the delimited theme block built from
      // the catalog recipe — are stored whole, with the shape.
      const composed =
        'TYPE INSTRUCTIONS 171\n\n--- THEME LAYOUT GUIDE (theme id: services-summit) ---\n' +
        services.themes[0].recipe +
        '\n--- END THEME LAYOUT GUIDE ---';
      res = await post(staffJar, '/api/v1/design', {
        type: 'website',
        title: 'B171 page-composed job',
        instructions: composed,
        leadId: 501,
        site_shape: 'multipage',
      });
      const pageJobBody = await json(res);
      assert.equal(res.status, 200, `page create 200 (got ${res.status}: ${JSON.stringify(pageJobBody).slice(0, 200)})`);
      const pageJob = pageJobBody.data.job;
      assert.ok(pageJob.instructions.includes('TYPE INSTRUCTIONS 171'), 'page-created job instructions carry the type instructions');
      assert.ok(pageJob.instructions.includes('theme id: services-summit'), 'page-created job instructions carry the theme recipe markers');
      const pageJobRow = wdb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(pageJob.id);
      assert.ok(pageJobRow && pageJobRow.instructions.includes('--- END THEME LAYOUT GUIDE ---'), 'stored job row keeps the full delimited theme block');
      assert.equal(pageJobRow.site_shape, 'multipage', 'page-created job row carries the site shape');
      n += 5;

      // Error contract, identical to the portal's.
      res = await post(staffJar, '/api/v1/assistant/themes/build', { themeId: 'store-northwind', leadId: 424242 });
      assert.equal(res.status, 404, 'staff unknown lead -> 404');
      res = await post(staffJar, '/api/v1/assistant/themes/build', { themeId: 'no-such-theme', leadId: 501 });
      assert.equal(res.status, 400, 'staff unknown theme -> 400');
      res = await post(staffJar, '/api/v1/assistant/themes/build', { themeId: 'store-northwind' });
      assert.equal(res.status, 400, 'staff no lead chosen -> 400');
      res = await post(staffJar, '/api/v1/assistant/themes/build', {
        themeId: 'blog-daily-field',
        newLead: { businessName: 'Copycat', email: 'second171@example.invalid' },
      });
      assert.equal(res.status, 409, 'staff duplicate lead email -> 409');
      const errBody = await json(res);
      assert.ok(errBody.ok === false && errBody.error, 'staff error body carries a message for the wizard');
      n += 5;
    } finally {
      child.kill('SIGKILL');
      await closed.catch(() => {});
    }
    group('Part 2 — staff HTTP routes, wizard build, errors', n);
  }

  /* ================================================================
   * Part 3 — UI source pins + theme-block behaviour units.
   * ================================================================ */
  {
    let n = 0;
    const appJs = read('public/js/app.js');
    const apiJs = read('public/js/api.js');
    const styles = read('public/styles.css');

    // Staff Assistant page: Themes card + mount + wizard.
    assert.ok(appJs.includes('id="asst-themes"'), 'staff Assistant page carries the Themes mount');
    assert.ok(appJs.includes('id="asst-themes-status"'), 'staff Assistant page carries the themes status line');
    assert.ok(appJs.includes('mountStaffThemes();'), 'pageAssistant mounts the staff Themes section');
    // Batch 173 adaptation (Ely's order): the staff wizard POPUP
    // is retired — "Build this" is its own page now — so the two
    // popup pins assert the replacement shape instead: the build
    // page + the shared submit (the wizard's submit, reused
    // verbatim), and the popup opener is gone from the staff app.
    assert.ok(appJs.includes('async function pageThemeBuild('), 'staff theme build page exists in app.js (Batch 173)');
    assert.ok(appJs.includes('async function submitStaffThemeBuild('), 'shared staff theme build submit exists in app.js (Batch 173)');
    assert.ok(!appJs.includes('openStaffThemeWizard'), 'no staff surface opens the theme wizard popup (Batch 173)');
    assert.ok(appJs.includes("'Build this'"), 'staff theme cards render a Build this button');
    assert.ok(appJs.includes('staff-themes-row'), 'Design New Job picker keeps its per-category theme rows');
    // Batch 176: on the Assistant page itself the rows became the
    // studio-desk gallery grid with a category pill/dropdown filter.
    assert.ok(appJs.includes('staff-themes-grid'), 'Assistant themes render in the gallery grid (Batch 176)');
    assert.ok(appJs.includes("stEl('span', 'staff-theme-tag'"), 'Assistant gallery cards carry the category tag (Batch 176)');
    n += 10;

    // Staff api client methods.
    assert.ok(apiJs.includes("assistantThemes: () => get('/assistant/themes')"), 'api client: catalog method');
    assert.ok(apiJs.includes("assistantThemesLeads: (q) => get('/assistant/themes/leads'"), 'api client: lead search method');
    assert.ok(apiJs.includes("assistantThemesBuild: (body) => post('/assistant/themes/build', body)"), 'api client: build method');
    n += 3;

    // Styles for the rows/cards + picker selected state.
    assert.ok(styles.includes('.staff-themes-row'), 'styles carry the horizontal theme rows');
    assert.ok(styles.includes('overflow-x: auto'), 'theme rows scroll horizontally');
    assert.ok(styles.includes('.dn-theme-card.selected'), 'styles carry the picker selected state');
    n += 3;

    // New Design Job page routing.
    assert.ok(appJs.includes("'design-new': pageDesignNew"), 'PAGES routes design-new to pageDesignNew');
    assert.ok(appJs.includes("'design-new': 'New design job'"), 'ROUTE_LABELS names the page');
    assert.ok(appJs.includes("route === 'design-new' && a.dataset.route === 'design'"), 'nav highlight maps design-new onto Design');
    assert.ok(appJs.includes("new: () => { window.location.hash = '#/design-new'; }"), 'Design list New button navigates to the page');
    const stubAt = appJs.indexOf('function openNewDesignModal()');
    assert.ok(stubAt > -1, 'openNewDesignModal name survives');
    const stub = appJs.slice(stubAt, appJs.indexOf('\n}', stubAt));
    assert.ok(stub.includes("window.location.hash = '#/design-new'"), 'openNewDesignModal is a redirect stub to the page');
    assert.ok(!stub.includes('designCreate') && !stub.includes('openModal'), 'the popup body is gone (one creation flow)');
    assert.ok(!appJs.includes('id="nd-type"') && !appJs.includes('nd-instr'), 'no popup field ids remain in app.js');
    n += 8;

    // The page carries the popup's behaviour + the theme picker.
    const pageAt = appJs.indexOf('async function pageDesignNew()');
    assert.ok(pageAt > -1, 'pageDesignNew exists');
    const page = appJs.slice(pageAt);
    assert.ok(page.includes('api.designDefaultInstructions()'), 'page loads the Batch 153 type catalog');
    assert.ok(page.includes('mountLeadPicker('), 'page uses the shared lead picker');
    assert.ok(page.includes('api.designCreate('), 'page creates through the same endpoint as the popup');
    assert.ok(page.includes('site_shape'), 'page carries the site shape through');
    assert.ok(page.includes('api.assistantThemes()'), 'page picker loads the shared catalog');
    assert.ok(page.includes('themeBlockText(theme)'), 'page picker inserts the delimited theme block');
    assert.ok(page.includes("shapeWrap.classList.toggle('hidden', t !== 'website')"), 'site shape row is website-only on the page');
    n += 8;

    // Theme-block helpers: eval straight out of app.js (the
    // designTypeFill pattern) and exercise the invariants.
    const hStart = appJs.indexOf('function themeBlockText(');
    const hEnd = appJs.indexOf('/* Batch 171 theme-block helpers end. */');
    assert.ok(hStart > -1 && hEnd > hStart, 'theme-block helpers block found in app.js');
    const helpers = new Function(
      appJs.slice(appJs.indexOf('const THEME_BLOCK_BEGIN'), hEnd) +
        '\nreturn { themeBlockText, splitThemeBlock, applyThemeBlock };'
    )();
    const themeA = { id: 'services-summit', recipe: 'RECIPE A\ntheme id: services-summit' };
    const themeB = { id: 'store-northwind', recipe: 'RECIPE B\ntheme id: store-northwind' };
    const blockA = helpers.themeBlockText(themeA);
    assert.ok(blockA.startsWith('--- THEME LAYOUT GUIDE (theme id: services-summit) ---'), 'block opens with the delimited header naming the theme id');
    assert.ok(blockA.endsWith('--- END THEME LAYOUT GUIDE ---'), 'block closes with the end delimiter');
    assert.equal(helpers.applyThemeBlock('', blockA), blockA, 'picking a theme on an empty brief inserts just the block');
    const withA = helpers.applyThemeBlock('Hand notes stay.', blockA);
    assert.equal(withA, 'Hand notes stay.\n\n' + blockA, 'picking a theme appends the block below hand text');
    const withB = helpers.applyThemeBlock(withA, helpers.themeBlockText(themeB));
    assert.ok(withB.startsWith('Hand notes stay.\n\n'), 'switching themes leaves hand text untouched');
    assert.ok(withB.includes('theme id: store-northwind') && !withB.includes('RECIPE A'), 'switching themes replaces the block');
    assert.equal(helpers.applyThemeBlock(withB, null), 'Hand notes stay.', '"No theme" removes the block and only the block');
    const roundTrip = helpers.applyThemeBlock(helpers.applyThemeBlock('Exact words — 100% mine.', blockA), null);
    assert.equal(roundTrip, 'Exact words — 100% mine.', 'pick then remove restores hand text byte-for-byte');
    assert.deepEqual(helpers.splitThemeBlock('plain text'), { body: 'plain text', block: '' }, 'split of a block-free brief');
    n += 9;

    // Type-change composition (the page's handler logic): the
    // designTypeFill rule applies to the body; the block rides
    // verbatim. designTypeFill is eval'd out of app.js too.
    const fStart = appJs.indexOf('function designTypeFill(');
    const fEnd = appJs.indexOf('\n}', fStart);
    const designTypeFill = new Function(appJs.slice(fStart, fEnd + 2) + '\nreturn designTypeFill;')();
    const typeChange = (text, autoFilled, next) => {
      const parts = helpers.splitThemeBlock(text);
      const nextBody = designTypeFill(parts.body, autoFilled, next);
      return helpers.applyThemeBlock(nextBody, parts.block || null);
    };
    const autoWithBlock = helpers.applyThemeBlock('WEB AUTO', blockA);
    const swapped = typeChange(autoWithBlock, 'WEB AUTO', 'LOGO AUTO');
    assert.equal(swapped, 'LOGO AUTO\n\n' + blockA, 'type change swaps the untouched auto-fill and keeps the block verbatim');
    const handWithBlock = helpers.applyThemeBlock('my own brief', blockA);
    const kept = typeChange(handWithBlock, 'WEB AUTO', 'LOGO AUTO');
    assert.equal(kept, 'my own brief\n\n' + blockA, 'type change never clobbers hand text with a block attached');
    n += 2;

    // Zero new census sinks from this batch.
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    // Batch 174 RE-PIN: the tree census is 506 / IDENT 41 — Batch
    // 174's design-chat redesign added exactly three IDENT
    // assistantMd(...) writes in portal.js (multiset-proven in
    // the Batch 174 suite). Batch 171's own movement stays zero;
    // RAW and safe classes are unchanged.
    assert.equal(cz.summary.total, 518, 'SEC-13 census total (Batch 174 re-pin — see note above)');
    assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 387, 'SEC-13 safe classes (Batch 176 re-pin: +1 STATIC from the pageAssistant shell reclassification — see batch103) unchanged by Batch 171');
    assert.equal(cz.summary.RAW, 88, 'SEC-13 RAW (Batch 176 re-pin: pageAssistant shell RAW -> STATIC — see batch103)');
    assert.equal(cz.summary.IDENT, 43, 'SEC-13 IDENT (Batch 174 re-pin — see note above)');
    const batchBlock = appJs.slice(appJs.indexOf('Batch 171 — Themes on the staff surfaces'));
    assert.ok(!batchBlock.includes('.innerHTML'), 'Batch 171 app.js block adds no innerHTML sink (createElement + textContent only)');
    n += 5;

    // Portal surface: Batch 172 (later in this deploy chain) removed
    // the portal themes; this finisher adaptation asserts the
    // post-chain state (staff-only Themes).
    const portalRoutes = read('server/routes/portal.js');
    assert.ok(!portalRoutes.includes("router.get('/assistant/themes'"), 'Batch 172: portal themes routes removed (staff-only)');
    assert.ok(!read('public/js/portal.js').includes('// Batch 169'), 'Batch 172: portal.js Batch 169 block removed');
    n += 2;
    group('Part 3 — UI pins, theme-block behaviour, census', n);
  }

  console.log(`\nbatch171 staff themes + design page: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main().catch((e) => {
  console.error('batch171 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
