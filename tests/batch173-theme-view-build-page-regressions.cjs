'use strict';
/**
 * Batch 173 — Theme View modal, Build-this page, Assistant two-column.
 *
 * Ely's orders (2026-11-09, three messages): (1) "Add view button
 * which opens the image in a scrollable modal"; (2) "put build
 * this in its own page"; (3) "make the assistant page like this —
 * the themes on the right and chat on the left" (screenshot of the
 * design page's narrow chat panel + wide content column).
 *
 * What this batch does (staff app only; portal files untouched —
 * Batch 172 owns the portal Themes removal):
 *  - Every staff theme card gains a View button beside Build this.
 *    View opens the shared openModal with the theme's full-page
 *    thumbnail inside .staff-theme-view-scroll (bounded height,
 *    overflow-y:auto); X button, backdrop click and Esc all close.
 *  - Build this navigates to #/themes-build/<themeId>
 *    (pageThemeBuild) carrying the retired wizard's exact fields;
 *    the submit is the wizard's own (submitStaffThemeBuild →
 *    api.assistantThemesBuild, same endpoint + payload). Unknown
 *    theme ids render a clean not-found state; no popup remains.
 *  - pageAssistant becomes two columns: LEFT .asst-rail (sticky,
 *    full-height) holds the chat card (context, conversations,
 *    messages scrolling inside the rail, composer) with the usage
 *    card tucked under it as a compact summary (same endpoint,
 *    same rendering — placement only); RIGHT .asst-content holds
 *    the Themes card. <=700px stacks single-column, chat first.
 *    The template edit kept EXACT line parity (33 lines -> 33) so
 *    no SEC-13 census sink line moved; the census is byte-
 *    identical to the Batch 171 tree (proven in Part 1).
 *
 * Batch 176 UPDATE (Ely approved the ground-up reimagine,
 * 2026-11-10): the two-column layout above is REPLACED by the
 * "one studio desk" design — usage as header stat tiles with the
 * full table (same endpoint, same rendering) in the Full-
 * breakdown modal; the chat as one full-width console
 * (conversation chip strip, centred reading column, docked
 * composer); Themes as a full-width gallery whose category
 * pills (dropdown at <=700px) filter a 3-column grid in place.
 * The View modal, the build page and the submit contract are
 * untouched; the layout pins in Parts 1/3 now assert the new
 * structure. Census re-pinned for the single pageAssistant
 * shell reclassification (RAW -> STATIC — see batch103).
 *
 * HARDENING (2026-11-10, Ely's order — the Batch 176 finisher
 * flagged this step, and it then stopped the Batch 177 gate
 * twice): the Full-breakdown step waited for the #asst-usage
 * ELEMENT to exist, then asserted on its text in the next
 * evaluate. But the modal is born with #asst-usage already
 * present, holding only a "Loading…" placeholder (the
 * openModal body in app.js), and refreshUsage() replaces its
 * innerHTML only after the usage fetch resolves — so the old
 * wait could release on the placeholder and the assertions
 * raced the fetch. Proven in the gate environment with an
 * in-page transition sampler: 53ms after the click,
 * #asst-usage existed with text exactly "Loading…" while the
 * populated summary landed later. On an idle box the fetch
 * usually wins the race; in a full gate leg it intermittently
 * loses (standalone history on the identical tree: 3 green /
 * 1 red, the red on this very assertion). The product render
 * is one atomic innerHTML swap and was never at fault; the
 * WAIT measured the wrong state. The fix is in HOW the step
 * waits, never in WHAT it asserts: it now waits for the
 * POPULATED state — the summary line with the client billed
 * figure AND both action buttons present, with the text
 * identical across 2 consecutive rAF polls. All assertions,
 * expected values and the 8s wait budget are unchanged.
 *
 * Part 1 — source pins: card controls, modal construction, build
 *   page routing + not-found + submit contract, two-column
 *   template structure, CSS facts (scroll container, rail,
 *   mobile stacking), census unchanged, portal wizard intact.
 * Part 2 — HTTP over the real server: the page's exact payload
 *   shape creates waiting_on_agent jobs (existing + new lead),
 *   error contract unchanged.
 * Part 3 — real Chromium, stub API: cards render with both
 *   buttons; the modal opens with the right image, scrolls, and
 *   closes all three ways; Build this navigates (no popup) and
 *   the page submits a payload identical to the wizard contract
 *   (captured at the stub); invalid theme -> not-found, no POST;
 *   desktop two-column geometry; 390px stacking + no overflow.
 *   B173_SKIP_BROWSER=1 skips Part 3 (local iteration only; the
 *   gate runs it in-image).
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch173-'));
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
process.env.SESSION_SECRET = ['batch173', 'regression', 'secret'].join('-');
process.env.BOOTSTRAP_EMAIL = 'root173@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Root', '173', 'Pass'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B173 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = '';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const PORT = 3483;
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
  /* ================================================================
   * Part 1 — source pins.
   * ================================================================ */
  {
    let n = 0;
    const appJs = read('public/js/app.js');
    const styles = read('public/styles.css');
    const portalJs = read('public/js/portal.js');

    // --- Theme card: both controls, correct wiring ---
    const cardAt = appJs.indexOf('function staffThemeCard(theme) {');
    assert.ok(cardAt > -1, 'staffThemeCard exists');
    const card = appJs.slice(cardAt, appJs.indexOf('function openStaffThemeView', cardAt));
    assert.ok(card.includes("stEl('div', 'staff-theme-card-actions')"), 'card groups its buttons in an actions row');
    assert.ok(card.includes("stEl('button', 'btn', 'View')"), 'card renders a View button');
    assert.ok(card.includes('openStaffThemeView(theme.id)'), 'View opens the theme view modal');
    assert.ok(card.includes("stEl('button', 'btn primary', 'Build this')"), 'card renders a Build this button');
    assert.ok(card.includes("'#/themes-build/' + encodeURIComponent(theme.id)"), 'Build this navigates to the build page route');
    assert.ok(!card.includes('openStaffThemeWizard'), 'card no longer opens any wizard popup');
    n += 7;

    // --- View modal construction ---
    const viewAt = appJs.indexOf('function openStaffThemeView(themeId) {');
    assert.ok(viewAt > -1, 'openStaffThemeView exists');
    const viewFn = appJs.slice(viewAt, appJs.indexOf('async function loadStaffThemeLeads', viewAt));
    assert.ok(viewFn.includes('openModal({'), 'view uses the shared openModal (backdrop + Esc + actions Close)');
    assert.ok(viewFn.includes("buttons: [{ label: 'Close' }]"), 'view modal carries a Close action');
    assert.ok(viewFn.includes("'staff-theme-view-modal'"), 'view modal carries its sizing class');
    assert.ok(viewFn.includes("setAttribute('aria-label', theme.name)"), 'view dialog is labelled by the theme name');
    assert.ok(viewFn.includes("'staff-theme-view-close'"), 'view modal adds an X close button');
    assert.ok(viewFn.includes("'staff-theme-view-scroll'"), 'view modal puts the image in the scroll container');
    assert.ok(viewFn.includes('img.src = theme.thumbnail'), 'view modal shows the theme full thumbnail');
    n += 7;

    // --- Wizard popup retired on the staff side; page + shared submit in ---
    assert.ok(!appJs.includes('openStaffThemeWizard'), 'staff wizard popup opener is gone');
    assert.ok(!appJs.includes('submitStaffThemeWizard'), 'wizard-named submit is gone (renamed to the shared page submit)');
    assert.ok(appJs.includes('async function pageThemeBuild(param)'), 'build page function exists');
    assert.ok(appJs.includes("'themes-build': pageThemeBuild"), 'PAGES routes themes-build to pageThemeBuild');
    assert.ok(appJs.includes("'themes-build': 'Build theme'"), 'ROUTE_LABELS names the build page');
    assert.ok(appJs.includes("route === 'themes-build' && a.dataset.route === 'assistant'"), 'nav highlight maps themes-build onto Assistant');
    const pageAt = appJs.indexOf('async function pageThemeBuild(param)');
    const page = appJs.slice(pageAt, appJs.indexOf('function wireStaffThemeBuildForm', pageAt));
    assert.ok(page.includes("'Theme not found'"), 'build page renders a not-found state for unknown themes');
    assert.ok(page.includes("back.href = '#/assistant'"), 'build page offers a way back to the Assistant');
    assert.ok(page.includes("id = 'stw-lead-select'") || page.includes("leadSelect.id = 'stw-lead-select'"), 'build page carries the lead select');
    assert.ok(page.includes("fresh.id = 'stw-new-fields'"), 'build page carries the add-a-lead fields');
    assert.ok(page.includes('wireStaffThemeBuildForm(card)'), 'build page wires the shared form behaviour');
    n += 10;

    // --- The submit is the wizard's contract, unchanged ---
    const subAt = appJs.indexOf('async function submitStaffThemeBuild(root) {');
    assert.ok(subAt > -1, 'shared submit exists');
    const sub = appJs.slice(subAt, appJs.indexOf('/* ---- Part 2:', subAt));
    for (const key of ['themeId: theme.id', 'businessName:', 'siteShape:', 'pagesWanted:', 'brandNotes:', 'payload.leadId = leadId', 'payload.newLead = {']) {
      assert.ok(sub.includes(key), `submit payload carries ${key}`);
    }
    assert.ok(sub.includes('api.assistantThemesBuild(payload)'), 'submit posts through the same api method the wizard used');
    assert.ok(sub.includes('staffThemesState.doneMessage = done'), 'submit leaves the confirmation for the Assistant status line');
    assert.ok(sub.includes("window.location.hash = '#/assistant'"), 'submit returns to the Assistant page');
    n += 10;

    // --- Studio-desk Assistant template structure (Batch 176) ---
    const tplAt = appJs.indexOf('async function pageAssistant()');
    const tpl = appJs.slice(tplAt, appJs.indexOf('`;', tplAt));
    const fnBody = appJs.slice(tplAt, appJs.indexOf('async function pageFingerprints()', tplAt));
    const iStrip = tpl.indexOf('class="asst-usage-strip"');
    const iConsole = tpl.indexOf('class="asst-console"');
    const iGallery = tpl.indexOf('class="asst-gallery"');
    const iThemes = tpl.indexOf('id="asst-themes"');
    assert.ok(iStrip > -1 && iConsole > iStrip && iGallery > iConsole, 'template stacks usage strip, console, gallery top to bottom');
    assert.ok(tpl.includes('id="asst-stat-calls"') && tpl.includes('id="asst-stat-raw"') && tpl.includes('id="asst-stat-billed"'), 'header carries the three usage stat tiles');
    assert.ok(tpl.includes('id="asst-usage-open"'), 'header carries the Full breakdown button');
    assert.ok(fnBody.includes('<div id="asst-usage">'), 'full usage table renders into the breakdown modal body');
    assert.ok(iThemes > iGallery, 'themes mount sits in the gallery below the console');
    assert.ok(tpl.includes('class="asst-chips"') && tpl.includes('id="asst-messages"') && tpl.includes('id="asst-form"'), 'chat internals unchanged inside the console');
    assert.ok(!tpl.includes('asst-rail') && !tpl.includes('asst-content'), 'the two-column rail layout is gone');
    n += 7;

    // --- CSS facts ---
    const scrollRule = styles.slice(styles.indexOf('.staff-theme-view-scroll {'));
    assert.ok(/\.staff-theme-view-scroll \{[^}]*overflow-y:\s*auto/.test(styles), 'view scroll container scrolls vertically');
    assert.ok(/\.staff-theme-view-scroll \{[^}]*max-height:/.test(styles), 'view scroll container is height-bounded');
    assert.ok(/\.staff-theme-view-scroll img \{[^}]*width:\s*100%/.test(styles), 'view image renders at the modal content width');
    assert.ok(/\.staff-theme-card-actions \{[^}]*display:\s*flex/.test(styles), 'card actions lay out as a row');
    assert.ok(/\.staff-themes-grid \{[^}]*grid-template-columns:\s*repeat\(3, 1fr\)/.test(styles), 'themes grid is 3 columns on desktop');
    assert.ok(/\.staff-themes-grid \{[^}]*gap:\s*20px/.test(styles), 'themes grid keeps the uniform 20px gap');
    assert.ok(/\.asst-thread-col \{[^}]*max-width:\s*780px/.test(styles), 'thread reading column is 780px');
    const mob = styles.slice(styles.lastIndexOf('@media (max-width: 700px)'));
    assert.ok(/\.staff-themes-grid \{[^}]*grid-template-columns:\s*1fr/.test(mob.slice(mob.indexOf('.staff-themes-grid'))), 'mobile: themes grid stacks to one column');
    assert.ok(/\.staff-theme-view-modal \{[^}]*width:\s*100%/.test(mob.slice(mob.indexOf('.staff-theme-view-modal'))), 'mobile: view modal goes near-full-screen');
    n += 9;

    // --- Census ---
    // Batch 174 RE-PIN (deliberate): the design-chat parity batch
    // changed the census — total 503 -> 506, IDENT 38 -> 41, RAW 86
    // unchanged, safe classes 379 unchanged. Pairwise (file,kind,
    // snippet) multiset diff vs this suite's base tree (batch173
    // f8cf166) = exactly +3 IDENT sinks in public/js/portal.js,
    // ZERO removed, every other movement pure line shift: the three
    // escape-first assistantMd(...) writes of the redesigned design
    // chat (bubble body, streamed delta, done-payload finalize) —
    // the same renderer class Batch 161 pinned for the Assistant
    // chat itself. Baseline regenerated 124 -> 127 entries.
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 507, STATIC: 188, ESCAPED: 48, SAFE: 81, BUILDER: 64, IDENT: 41, RAW: 85 },
      'SEC-13 census summary (Batch 174 re-pin: +3 IDENT assistantMd writes in portal.js — see note above)'
    );
    const crypto = require('node:crypto');
    const multi = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multi.join('\n')).digest('hex');
    assert.equal(sha, 'fcd696c84245a0d56bc865051805924f8c1449eec2eb3a8f3e2b6ab9a7fdcd5e', 'SEC-13 (file|kind|snippet) multiset pinned (Batch 174 re-pin — see note above)');
    const base = new Set(require(path.join(root, 'tests/batch103-xss-baseline.json')));
    const reviewed = new Set(cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`));
    assert.deepEqual([...reviewed].filter((x) => !base.has(x)), [], 'no unreviewed RAW/IDENT sink (Batch 176 baseline regenerated — see batch103)');
    assert.deepEqual([...base].filter((x) => !reviewed.has(x)), [], 'no baseline sink unaccounted');
    n += 4;

    // --- Portal: Batch 172 (earlier in this deploy chain) removed the
    // portal Themes surface entirely; finisher adaptation asserts the
    // post-chain state. This batch itself touches no portal file. ---
    assert.ok(!portalJs.includes('function openThemeWizard('), 'Batch 172: portal wizard popup removed (staff-only Themes)');
    assert.ok(!portalJs.includes("api('/assistant/themes/build'"), 'Batch 172: portal build path removed with the portal surface');
    n += 2;
    group('Part 1 — source pins: card, modal, page, studio-desk layout, census', n);
  }

  /* ================================================================
   * Part 2 — HTTP over the real server: the page's payload shape.
   * (Fixtures mirror batch171 Part 2.)
   * ================================================================ */
  {
    let n = 0;
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const wdb = openWorkspaceDb(1);
    wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (501, ?, ?, ?)').run('Fixture Plants LLC', 'owner173@example.invalid', 'customer');
    wdb.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (777, ?, ?, ?)').run('Second Biz', 'second173@example.invalid', 'customer');
    const db = require(path.join(root, 'server/db.js'));
    await db.migrate();

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
      const totp = require(path.join(root, 'src/totp.js'));
      const staffJar = makeJar();
      let res = await post(staffJar, '/api/v1/auth/login', {
        email: process.env.BOOTSTRAP_EMAIL,
        password: ['Root', '173', 'Pass'].join('-'),
      });
      let loginBody = await json(res);
      assert.equal(res.status, 200, `staff login 200 (got ${res.status})`);
      if (loginBody.data && loginBody.data.mfaRequired && loginBody.data.mfaStage === 'enroll') {
        const start = await json(await post(staffJar, '/api/v1/auth/mfa/enroll/start', {}));
        await post(staffJar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
      }
      n += 1;

      // The exact payload the build page sends for an existing lead
      // (same keys/values the retired wizard produced — Part 3
      // captures the page's real POST and compares shape).
      const pagePayload = {
        themeId: 'services-summit',
        businessName: 'Second Biz',
        siteShape: 'multipage',
        pagesWanted: 'Home, Services',
        brandNotes: 'Warm oak and cream.',
        leadId: 777,
      };
      const buildBody = await json(await post(staffJar, '/api/v1/assistant/themes/build', pagePayload));
      assert.ok(buildBody.ok && buildBody.data && buildBody.data.jobId, 'page-shaped payload creates a job');
      assert.equal(buildBody.data.status, 'waiting_on_agent', 'job staged waiting_on_agent');
      const jobRow = wdb.prepare('SELECT * FROM design_jobs WHERE id = ?').get(buildBody.data.jobId);
      assert.equal(jobRow.lead_id, 777, 'job attached to the picked lead');
      assert.equal(jobRow.status, 'waiting_on_agent', 'job row staged');
      assert.ok(jobRow.instructions.includes('theme id: services-summit'), 'job instructions carry the theme recipe (theme applied as the wizard applied it)');
      n += 5;

      // New-lead page payload.
      const freshBody = await json(
        await post(staffJar, '/api/v1/assistant/themes/build', {
          themeId: 'store-northwind',
          businessName: 'Page Test Bakery',
          siteShape: 'multipage',
          pagesWanted: '',
          brandNotes: '',
          newLead: { businessName: 'Page Test Bakery', category: '', city: 'Reading', contactName: '', email: 'bakery173@example.invalid', phone: '' },
        })
      );
      assert.ok(freshBody.ok && freshBody.data.jobId && freshBody.data.leadId > 0, 'page-shaped new-lead payload creates lead + job');
      n += 1;

      // Error contract unchanged.
      res = await post(staffJar, '/api/v1/assistant/themes/build', { themeId: 'no-such-theme', leadId: 501 });
      assert.equal(res.status, 400, 'unknown theme -> 400 (the page never sends this; it renders not-found instead)');
      n += 1;
    } finally {
      child.kill('SIGKILL');
      await closed.catch(() => {});
    }
    group('Part 2 — HTTP: page payload creates staged jobs', n);
  }

  /* ================================================================
   * Part 3 — real Chromium, stub API: the three features live.
   * ================================================================ */
  if (process.env.B173_SKIP_BROWSER === '1') {
    console.log('  skip Part 3 browser (B173_SKIP_BROWSER=1 — local iteration only)');
  } else {
    let n = 0;
    const puppeteer = require('puppeteer');
    const http = require('node:http');
    const express = require('express');
    const registry = require(path.join(root, 'server/themesRegistry.js'));
    const catalog = registry.publicCatalog();
    const themeCount = catalog.reduce((a, c) => a + (c.themes || []).length, 0);

    const captured = [];
    const app = express();
    app.use(express.json());
    const ME = { ok: true, data: { user: { id: 1, email: 'fixture@example.invalid', isSuperAdmin: true }, workspaceId: 1, workspaces: [{ id: 1, name: 'Fixture', role: 'owner' }], isSuperAdmin: true, productAccess: true } };
    app.get('/api/v1/auth/me', (_q, r) => r.json(ME));
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/assistant/themes', (_q, r) => r.json({ ok: true, data: { categories: catalog } }));
    app.get('/api/v1/assistant/themes/leads', (_q, r) =>
      r.json({
        ok: true,
        data: {
          leads: [
            { id: 501, business_name: 'Fixture Plants LLC', category: 'Plants', city: 'Blandon' },
            { id: 777, business_name: 'Second Biz', category: 'Retail', city: 'Reading' },
          ],
        },
      })
    );
    app.post('/api/v1/assistant/themes/build', (req, r) => {
      captured.push(req.body || {});
      const theme = registry.getTheme(req.body && req.body.themeId);
      r.json({
        ok: true,
        data: {
          jobId: 4242,
          status: 'waiting_on_agent',
          leadId: (req.body && (req.body.leadId || 999)) || 999,
          themeId: req.body && req.body.themeId,
          themeName: theme ? theme.name : 'Unknown',
        },
      });
    });
    app.get('/api/v1/assistant/conversations', (_q, r) =>
      r.json({
        ok: true,
        data: [
          { id: 11, title: 'Fixture chat one', leadId: null },
          { id: 12, title: 'Fixture chat two', leadId: null },
        ],
      })
    );
    app.get('/api/v1/assistant/conversations/:id', (req, r) =>
      r.json({
        ok: true,
        data: {
          conversation: { id: Number(req.params.id), leadId: null },
          messages: [
            { role: 'user', content: 'Fixture question', attachments: [] },
            { role: 'assistant', content: 'Fixture answer', attachments: [] },
          ],
        },
      })
    );
    app.get('/api/v1/assistant/usage', (_q, r) =>
      r.json({
        ok: true,
        data: {
          month: '2026-11',
          portal: { rawUsd: 1.5, billedUsd: 1.8 },
          admin: { rawUsd: 2.25 },
          byUser: [{ surface: 'admin', actorId: 1, calls: 3, rawUsd: 2.25, billedUsd: 0 }],
          rollup: { status: 'accrued' },
        },
      })
    );
    app.get('/api/v1/leads', (_q, r) => r.json({ ok: true, data: { leads: [], total: 0 } }));
    app.use('/api/v1', (req, res) => {
      if (req.method !== 'GET') return res.status(500).json({ ok: false, error: 'No fixture writes allowed' });
      res.json({ ok: true, data: {} });
    });
    app.get('/app', (_q, r) => r.sendFile(path.join(root, 'public', 'index.html')));
    app.use(express.static(path.join(root, 'public'), { index: false }));

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    else if (fs.existsSync('/usr/bin/chromium')) launchOpts.executablePath = '/usr/bin/chromium';
    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));
      const goto = async (hash, waitFn, label) => {
        await page.goto(base + '/app' + hash, { waitUntil: 'load' });
        await page.waitForFunction(waitFn, { timeout: 15000 }).catch(() => {
          throw new Error(`screen did not render: ${label} (${hash}); pageerrors: ${errors.join(' | ')}`);
        });
      };

      // ---- Desktop: assistant renders, two columns, cards complete ----
      await page.setViewport({ width: 1440, height: 900 });
      await goto('#/assistant', () => document.querySelectorAll('.staff-theme-card').length > 0, 'assistant themes');
      const cardAudit = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.staff-theme-card')];
        return {
          count: cards.length,
          allHaveBoth: cards.every((c) => {
            const labels = [...c.querySelectorAll('button')].map((b) => b.textContent.trim());
            return labels.includes('View') && labels.includes('Build this');
          }),
        };
      });
      assert.equal(cardAudit.count, themeCount, `all ${themeCount} theme cards render`);
      assert.ok(cardAudit.allHaveBoth, 'every theme card has both View and Build this');
      n += 2;

      await page.waitForFunction(() => (document.querySelector('#asst-stat-calls') || {}).textContent === '3', { timeout: 8000 });
      const layout = await page.evaluate(() => {
        const consoleEl = document.querySelector('.asst-console');
        const gallery = document.querySelector('.asst-gallery');
        const msgs = document.querySelector('#asst-messages');
        const col = document.querySelector('#asst-thread-col');
        const chips = [...document.querySelectorAll('#asst-convs .asst-chip')];
        const grid = document.querySelector('.staff-themes-grid');
        return {
          consoleAboveGallery: consoleEl.getBoundingClientRect().bottom <= gallery.getBoundingClientRect().top + 1,
          consoleContainsChat: !!consoleEl.querySelector('#asst-form') && !!consoleEl.querySelector('#asst-lead'),
          galleryContainsThemes: !!gallery.querySelector('#asst-themes'),
          messagesOverflowY: getComputedStyle(msgs).overflowY,
          threadColWidth: col.getBoundingClientRect().width,
          chipCount: chips.length,
          firstChipIsNew: chips.length > 0 && chips[0].id === 'asst-new',
          chipTitles: chips.map((c) => c.textContent.trim()),
          activeChip: (chips.find((c) => c.classList.contains('active')) || {}).textContent || '',
          gridColumns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          tileCalls: (document.querySelector('#asst-stat-calls') || {}).textContent || '',
          tileRaw: (document.querySelector('#asst-stat-raw') || {}).textContent || '',
          tileBilled: (document.querySelector('#asst-stat-billed') || {}).textContent || '',
        };
      });
      assert.ok(layout.consoleAboveGallery, 'desktop: chat console sits above the themes gallery');
      assert.ok(layout.consoleContainsChat, 'desktop: console holds the composer + site select');
      assert.ok(layout.galleryContainsThemes, 'desktop: themes render in the gallery below');
      assert.equal(layout.messagesOverflowY, 'auto', 'desktop: messages area is the internal-scroll element');
      assert.ok(layout.threadColWidth <= 780 + 1, 'desktop: thread reading column is bounded at 780px');
      assert.equal(layout.chipCount, 3, 'chip strip renders New + both fixture conversations');
      assert.ok(layout.firstChipIsNew, 'chip strip leads with the New conversation chip');
      assert.ok(layout.chipTitles.includes('Fixture chat one') && layout.chipTitles.includes('Fixture chat two'), 'chip strip renders conversation titles');
      assert.ok(layout.activeChip.includes('Fixture chat one'), 'the opened conversation chip is active');
      assert.equal(layout.gridColumns, 3, 'desktop: themes grid renders 3 columns');
      assert.equal(layout.tileCalls, '3', 'usage tile: calls populate from the usage endpoint');
      assert.equal(layout.tileRaw, '$3.75', 'usage tile: raw cost totals portal + staff');
      assert.equal(layout.tileBilled, '$1.80', 'usage tile: billed out is the portal billed figure');
      n += 13;

      // ---- Full breakdown: the full usage table lives in a modal ----
      await page.click('#asst-usage-open');
      // HARDENED WAIT (see header): the modal is born holding a
      // "Loading…" placeholder and refreshUsage() swaps in the
      // populated breakdown asynchronously, so the existence of
      // #asst-usage proves nothing. Wait for the POPULATED state:
      // the summary line (client billed figure) AND both action
      // buttons present, with the rendered text identical across
      // 2 consecutive rAF polls. The swap is one atomic innerHTML
      // assignment, so this is the finished render, never a
      // partial state. Same 8s budget as the wait it replaces.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('#asst-usage');
          const t = el ? el.textContent || '' : '';
          const populated =
            !!el && t.includes('client billed') && !!document.querySelector('#asst-rollup') && !!document.querySelector('#asst-queue');
          if (!populated) {
            window.__b173Bd = null;
            window.__b173BdN = 0;
            return false;
          }
          if (window.__b173Bd === t) window.__b173BdN += 1;
          else {
            window.__b173Bd = t;
            window.__b173BdN = 1;
          }
          return window.__b173BdN >= 2;
        },
        { timeout: 8000, polling: 'raf' }
      );
      const breakdown = await page.evaluate(() => {
        const el = document.querySelector('#asst-usage');
        return {
          text: el.textContent || '',
          hasRollup: !!document.querySelector('#asst-rollup'),
          hasQueue: !!document.querySelector('#asst-queue'),
          inModal: !!el.closest('.modal-backdrop'),
        };
      });
      assert.ok(breakdown.inModal, 'breakdown table renders inside a modal');
      assert.ok(breakdown.text.includes('client billed'), 'breakdown keeps the summary line (client billed figure)');
      assert.ok(breakdown.text.includes('Staff (internal)'), 'breakdown table keeps the surface x user rows');
      assert.ok(breakdown.hasRollup && breakdown.hasQueue, 'breakdown keeps the rollup + queue actions');
      n += 4;
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#asst-usage'), { timeout: 8000 });

      // ---- Category filter: pills filter the grid in place ----
      const storeCount = (catalog.find((c) => c.id === 'store') || { themes: [] }).themes.length;
      await page.evaluate(() => {
        const pill = [...document.querySelectorAll('#asst-pills .asst-pill')].find((p) => p.dataset.cat === 'store');
        pill.click();
      });
      await page.waitForFunction((want) => document.querySelectorAll('.staff-theme-card').length === want, { timeout: 8000 }, storeCount);
      assert.ok(true, 'category pill filters the grid to that category');
      n += 1;
      const selSync = await page.evaluate(() => document.querySelector('#asst-cat-select').value);
      assert.equal(selSync, 'store', 'mobile dropdown stays in sync with the pill filter');
      n += 1;
      await page.evaluate(() => {
        const pill = [...document.querySelectorAll('#asst-pills .asst-pill')].find((p) => p.dataset.cat === 'all');
        pill.click();
      });
      await page.waitForFunction((want) => document.querySelectorAll('.staff-theme-card').length === want, { timeout: 8000 }, themeCount);
      assert.ok(true, 'All pill restores the full grid');
      n += 1;

      // ---- View modal: open, correct image, scrolls, closes 3 ways ----
      const firstTheme = await page.evaluate(() => {
        const img = document.querySelector('.staff-theme-frame img');
        return img ? img.getAttribute('src') : '';
      });
      const clickCardButton = (label) =>
        page.evaluate((lbl) => {
          const btn = [...document.querySelectorAll('.staff-theme-card button')].find((b) => b.textContent.trim() === lbl);
          if (btn) btn.click();
        }, label);
      await clickCardButton('View');
      await page.waitForFunction(() => !!document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      const modalAudit = await page.evaluate(() => {
        const modal = document.querySelector('.staff-theme-view-modal');
        const scroller = modal.querySelector('.staff-theme-view-scroll');
        const img = scroller.querySelector('img');
        return {
          role: modal.getAttribute('role'),
          ariaModal: modal.getAttribute('aria-modal'),
          ariaLabel: modal.getAttribute('aria-label'),
          imgSrc: img.getAttribute('src'),
          overflowY: getComputedStyle(scroller).overflowY,
          scrollable: scroller.scrollHeight > scroller.clientHeight + 10,
          hasX: !!modal.querySelector('.staff-theme-view-close'),
        };
      });
      assert.equal(modalAudit.role, 'dialog', 'view modal is a dialog');
      assert.equal(modalAudit.ariaModal, 'true', 'view modal is modal');
      assert.ok(modalAudit.ariaLabel && modalAudit.ariaLabel.length > 1, 'view modal is labelled by the theme name');
      assert.equal(modalAudit.imgSrc, firstTheme, 'view modal shows the clicked theme thumbnail');
      assert.equal(modalAudit.overflowY, 'auto', 'view modal scroll container scrolls vertically');
      assert.ok(modalAudit.scrollable, 'view modal content is taller than the bounded container (scrollable)');
      assert.ok(modalAudit.hasX, 'view modal has an X close button');
      n += 7;
      const scrolled = await page.evaluate(() => {
        const scroller = document.querySelector('.staff-theme-view-scroll');
        scroller.scrollTop = 160;
        return scroller.scrollTop;
      });
      assert.ok(scrolled > 100, 'view modal image actually scrolls inside the container');
      n += 1;
      // Close 1: X.
      await page.click('.staff-theme-view-close');
      await page.waitForFunction(() => !document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      assert.ok(true, 'view modal closes via X');
      n += 1;
      // Close 2: Esc.
      await clickCardButton('View');
      await page.waitForFunction(() => !!document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      assert.ok(true, 'view modal closes via Esc');
      n += 1;
      // Close 3: backdrop mousedown.
      await clickCardButton('View');
      await page.waitForFunction(() => !!document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      await page.mouse.click(8, 8);
      await page.waitForFunction(() => !document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      assert.ok(true, 'view modal closes via backdrop click');
      n += 1;

      // ---- Build this: navigates to the page, NO popup ----
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.staff-theme-card')];
        const target = cards.find((c) => c.querySelector('h4') && c.querySelector('h4').textContent.includes('Summit'));
        const btn = [...target.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Build this');
        btn.click();
      });
      await page.waitForFunction(() => window.location.hash.startsWith('#/themes-build/'), { timeout: 8000 });
      assert.ok((await page.evaluate(() => window.location.hash)).includes('services-summit'), 'Build this navigates to the theme build page');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.modal-backdrop').length), 0, 'no wizard popup opens');
      n += 2;
      await page.waitForFunction(
        () => document.querySelector('#stw-lead-select') && document.querySelector('#stw-lead-select').options.length > 0,
        { timeout: 10000 }
      );
      const pageAudit = await page.evaluate(() => ({
        themeName: (document.querySelector('#stw-theme-name') || {}).textContent || '',
        imgSrc: (document.querySelector('#stw-theme-img') || {}).getAttribute('src') || '',
        hasNewFields: !!document.querySelector('#stw-new-fields'),
        hasShape: !!document.querySelector('#stw-shape'),
      }));
      assert.ok(pageAudit.themeName.includes('Summit'), 'build page renders the clicked theme');
      assert.ok(pageAudit.imgSrc.includes('/themes/services.png'), 'build page shows the theme thumbnail');
      assert.ok(pageAudit.hasNewFields && pageAudit.hasShape, 'build page carries lead-add fields + site shape');
      n += 3;

      // Submit with an existing lead; capture the real POST.
      await page.select('#stw-lead-select', '777');
      await page.type('#stw-pages', 'Home, Services');
      await page.type('#stw-brand', 'Warm oak and cream.');
      const before = captured.length;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.staff-theme-build-card button')].find((b) => b.textContent.trim() === 'Build');
        btn.click();
      });
      await page.waitForFunction(() => window.location.hash === '#/assistant', { timeout: 12000 });
      assert.equal(captured.length, before + 1, 'build page posted exactly one build request');
      const payload = captured[captured.length - 1];
      assert.deepEqual(
        Object.keys(payload).sort(),
        ['brandNotes', 'businessName', 'leadId', 'pagesWanted', 'siteShape', 'themeId'],
        'page payload keys match the wizard contract exactly'
      );
      assert.equal(payload.themeId, 'services-summit', 'payload theme id');
      assert.equal(payload.leadId, 777, 'payload lead id (number, as the wizard sent)');
      assert.equal(payload.businessName, 'Second Biz', 'payload business name synced from the lead');
      assert.equal(payload.siteShape, 'multipage', 'payload site shape');
      assert.equal(payload.pagesWanted, 'Home, Services', 'payload pages wanted');
      assert.equal(payload.brandNotes, 'Warm oak and cream.', 'payload brand notes');
      n += 8;
      await page.waitForFunction(
        () => (document.querySelector('#asst-themes-status') || {}).textContent.includes('job #4242'),
        { timeout: 10000 }
      );
      assert.ok(true, 'assistant themes status line confirms the queued job (wizard behaviour)');
      n += 1;

      // New-lead path on a second theme.
      await page.evaluate(() => {
        window.location.hash = '#/themes-build/store-northwind';
      });
      await page.waitForFunction(() => !!document.querySelector('#stw-new-fields'), { timeout: 10000 });
      await page.click('input[name="stw-mode"][value="new"]');
      await page.type('#stw-new-name', 'Page Test Bakery');
      await page.type('#stw-new-email', 'bakery173@example.invalid');
      const before2 = captured.length;
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('.staff-theme-build-card button')].find((b) => b.textContent.trim() === 'Build');
        btn.click();
      });
      await page.waitForFunction(() => window.location.hash === '#/assistant', { timeout: 12000 });
      assert.equal(captured.length, before2 + 1, 'new-lead build posted exactly one request');
      const payload2 = captured[captured.length - 1];
      assert.ok(!('leadId' in payload2), 'new-lead payload carries no leadId');
      assert.deepEqual(
        Object.keys(payload2.newLead || {}).sort(),
        ['businessName', 'category', 'city', 'contactName', 'email', 'phone'],
        'newLead keys match the wizard contract exactly'
      );
      assert.equal(payload2.newLead.businessName, 'Page Test Bakery', 'newLead business name');
      assert.equal(payload2.businessName, 'Page Test Bakery', 'payload business name falls back to the new lead name (wizard rule)');
      n += 5;

      // Invalid theme id: clean not-found, no POST.
      const before3 = captured.length;
      await page.evaluate(() => {
        window.location.hash = '#/themes-build/no-such-theme';
      });
      await page.waitForFunction(() => document.body.textContent.includes('Theme not found'), { timeout: 10000 });
      assert.equal(captured.length, before3, 'invalid theme creates no job');
      assert.ok(
        await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '#/assistant')),
        'not-found state offers a way back'
      );
      n += 2;

      // ---- 390px: stacking, no overflow, modal + build nav usable ----
      await page.setViewport({ width: 390, height: 844 });
      await goto('#/assistant', () => document.querySelectorAll('.staff-theme-card').length > 0, 'assistant themes @390');
      const mobile = await page.evaluate(() => {
        const chat = document.querySelector('.asst-console').getBoundingClientRect();
        const themes = document.querySelector('.asst-gallery').getBoundingClientRect();
        const pills = document.querySelector('#asst-pills');
        const sel = document.querySelector('#asst-cat-select');
        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          chatFirst: chat.top < themes.top,
          pillsHidden: getComputedStyle(pills).display === 'none',
          selectShown: getComputedStyle(sel).display !== 'none',
          gridOneCol: getComputedStyle(document.querySelector('.staff-themes-grid')).gridTemplateColumns.split(' ').length === 1,
        };
      });
      assert.ok(mobile.noOverflow, '390px: no horizontal overflow on the assistant page');
      assert.ok(mobile.chatFirst, '390px: chat stacks before themes');
      assert.ok(mobile.pillsHidden && mobile.selectShown, '390px: category pills become the dropdown');
      assert.ok(mobile.gridOneCol, '390px: themes grid is one column');
      n += 4;
      await clickCardButton('View');
      await page.waitForFunction(() => !!document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      const mobileModal = await page.evaluate(() => {
        const scroller = document.querySelector('.staff-theme-view-scroll');
        return {
          overflowY: getComputedStyle(scroller).overflowY,
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        };
      });
      assert.equal(mobileModal.overflowY, 'auto', '390px: view modal container is the vertical scroller');
      assert.ok(mobileModal.noOverflow, '390px: view modal causes no horizontal overflow');
      n += 2;
      // Scrollability proof at phone width: on a tall phone the
      // directory shot happens to fit the bound whole, so shrink
      // the viewport height (short-phone case) — the SAME image in
      // the SAME container must now overflow and scroll.
      await page.setViewport({ width: 390, height: 560 });
      const mobileScroll = await page.evaluate(() => {
        const scroller = document.querySelector('.staff-theme-view-scroll');
        const overflows = scroller.scrollHeight > scroller.clientHeight + 10;
        scroller.scrollTop = 120;
        return { overflows, top: scroller.scrollTop };
      });
      assert.ok(mobileScroll.overflows && mobileScroll.top > 50, '390px: view modal image scrolls inside its container when it exceeds the bound');
      n += 1;
      await page.setViewport({ width: 390, height: 844 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.staff-theme-view-modal'), { timeout: 8000 });
      await clickCardButton('Build this');
      await page.waitForFunction(() => window.location.hash.startsWith('#/themes-build/'), { timeout: 8000 });
      const mobileBuild = await page.evaluate(() => ({
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        hash: window.location.hash,
      }));
      assert.ok(mobileBuild.noOverflow, '390px: build page has no horizontal overflow');
      assert.ok(mobileBuild.hash.includes('/themes-build/'), '390px: Build this still navigates to the build page');
      n += 2;
    } finally {
      await browser.close().catch(() => {});
      server.close();
    }
    group('Part 3 — browser: modal, build page, studio desk, 390px', n);
  }

  console.log(`\nbatch173 theme view + build page + studio desk: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main().catch((e) => {
  console.error('batch173 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
