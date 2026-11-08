'use strict';
/**
 * Batch 156 — SITE FINGERPRINT (Phase 1 of the future-enhancement plan;
 * spec: website-scout/section-variants-spec.md §4a).
 *
 * Pins:
 *   Part 1 — the pure module: determinism (same model → identical
 *     fingerprint + hash, immune to stored key order), layout
 *     sensitivity (reorder → layout half + hash move, brand half
 *     still), brand sensitivity (font change → brand half + hash move,
 *     layout half still), slug normalisation ('/' ≡ 'index' ≡
 *     '/index.html'), nav pattern (navVisible:false leaves navSlugs,
 *     stays in pageSlugs), hero signal from stored content shape.
 *   Part 2 — colour distance + the double-match rule: CIE76 ΔE unit
 *     cases (identical 0, black/white ≈ 100, one-step shade < 2,
 *     non-hex null); compare cases (double-match, layout-only,
 *     brand-only, neither); similarityReport grouping (cross-workspace
 *     double-matches flagged, same-workspace pairs separated, never
 *     flagged).
 *   Part 3 — domain + MCP in-process: fixtures across two workspaces;
 *     sitesGet carries the fingerprint, sitesList rows carry
 *     hash + summary, siteFingerprintGet returns the module's
 *     fingerprint plus the site's flagged/same-client pairs, the
 *     ledger lists every site, unknown id errors SITE_NOT_FOUND, and
 *     the MCP tool website.fingerprint dispatches to the same result
 *     as the module (and is registered exactly once in toolDefs).
 *   Part 4 — render invariance: this batch adds NO renderer changes;
 *     the fixture site's renderSite HTML is byte-identical to the
 *     Batch 155 tree's output (sha256 pinned from that tree).
 *   Part 5 — HTTP over the real server: unauthenticated reads refused;
 *     a workspace owner reads her site's fingerprint; the ledger
 *     refuses a non-super-admin and serves the super-admin the full
 *     baseline (sites + flagged pairs).
 *   Part 6 — source pins for the staff surface (detail card, list
 *     column, ledger page + route + nav) and the REST routes.
 *
 * Real-server parts follow the sibling header convention:
 * CAPTCHA_OPTIONAL=1 + APP_URL are set for the spawned server.
 * B156_SKIP_HTTP=1 skips Part 5 locally; the gate runs everything.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b156-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch156', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b156@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['Batch156', 'Bootstrap', 'Pass'].join('-') + '!';
process.env.BOOTSTRAP_WORKSPACE = 'B156 Bootstrap WS';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31556;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch156', 'fixture', 'password'].join('-');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
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

/* ---------------- fixtures ---------------- */

const THEME_BASE = {
  primary: '#1a56db',
  secondary: '#0e2a5c',
  bg: '#ffffff',
  text: '#1f2937',
  font: '"Karla", sans-serif',
  headingFont: '"Fraunces", serif',
  logoMode: 'text',
  logoUrl: '',
};
function fixturePages() {
  return [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'nav', content: { business_name: 'Fixture Co', links: [] } },
        {
          type: 'hero',
          content: {
            backgroundImage: 'images/hero.jpg',
            headline: 'Fixture headline',
            subheadline: 'Fixture sub',
            cta_text: 'Call us',
            cta_href: 'tel:+15550100',
            cta_secondary_text: 'Services',
            cta_secondary_href: '#services',
          },
        },
        { type: 'services', content: { title: 'Services', items: [{ title: 'One' }, { title: 'Two' }] } },
        { type: 'about', content: { title: 'About', paragraphs: ['We do fixtures.'] } },
        { type: 'cta', content: { title: 'Go', text: 'Now', button_text: 'Call', button_href: 'tel:+15550100' } },
        { type: 'footer', content: { business_name: 'Fixture Co' } },
      ],
    },
    {
      slug: 'services',
      title: 'Services',
      sections: [
        { type: 'nav', content: { business_name: 'Fixture Co', links: [] } },
        { type: 'heading', content: { title: 'Services' } },
        { type: 'services', content: { title: 'Services', items: [{ title: 'One' }] } },
        { type: 'footer', content: { business_name: 'Fixture Co' } },
      ],
    },
    {
      slug: 'faq',
      title: 'FAQ',
      navVisible: false,
      sections: [
        { type: 'nav', content: { business_name: 'Fixture Co', links: [] } },
        { type: 'faq', content: { title: 'FAQ', items: [{ q: 'Q?', a: 'A.' }] } },
        { type: 'footer', content: { business_name: 'Fixture Co' } },
      ],
    },
  ];
}
const MODEL_BASE = { theme: THEME_BASE, pages: fixturePages() };

(async () => {
  const fp = require(path.join(root, 'server/siteFingerprint.js'));

  /* ================================================================== */
  /* Part 1 — the pure module                                            */
  /* ================================================================== */
  {
    let n = 0;
    const a = fp.computeFingerprint(MODEL_BASE);
    const b = fp.computeFingerprint(JSON.parse(JSON.stringify(MODEL_BASE)));
    assert.deepEqual(a, b, 'same model → identical fingerprint object');
    assert.equal(a.hash, b.hash, 'same model → identical hash');
    n += 2;

    // Stored key order must not matter (canonical JSON hash input).
    const shuffled = {
      pages: MODEL_BASE.pages.map((p) => ({ sections: p.sections, title: p.title, slug: p.slug, ...(p.navVisible === false ? { navVisible: false } : {}) })),
      theme: Object.fromEntries(Object.entries(MODEL_BASE.theme).reverse()),
    };
    assert.equal(fp.computeFingerprint(shuffled).hash, a.hash, 'stored key order cannot move the hash');
    n++;

    assert.deepEqual(a.layout.homeSections, ['hero', 'services', 'about', 'cta'], 'home sequence excludes chrome (nav/footer)');
    assert.deepEqual(a.layout.pageSlugs, ['faq', 'index', 'services'], 'page slug set');
    assert.deepEqual(a.layout.navSlugs, ['index', 'services'], 'navVisible:false page leaves the nav pattern only');
    assert.deepEqual(a.layout.hero, { present: true, backgroundImage: true, cta: true, secondaryCta: true, align: null }, 'hero signal from stored content shape');
    n += 4;

    assert.deepEqual(a.brand.fonts, { heading: 'fraunces', body: 'karla' }, 'font pairing = first families, unquoted, lowercased');
    assert.equal(a.brand.palette.primary, '#1a56db');
    assert.deepEqual(a.brand.logo, { mode: 'text', hasUrl: false }, 'logo treatment');
    n += 3;

    // Slug spellings of the homepage are one page.
    for (const slug of ['/', '/index', '/index.html', 'INDEX']) {
      const pages = fixturePages();
      pages[0] = { ...pages[0], slug };
      assert.equal(fp.computeFingerprint({ theme: THEME_BASE, pages }).layoutHash, a.layoutHash, `home slug '${slug}' ≡ 'index'`);
      n++;
    }

    // Layout sensitivity: reorder the home sections.
    const reordered = fixturePages();
    const hero = reordered[0].sections[1];
    reordered[0].sections[1] = reordered[0].sections[2];
    reordered[0].sections[2] = hero;
    const r = fp.computeFingerprint({ theme: THEME_BASE, pages: reordered });
    assert.notEqual(r.layoutHash, a.layoutHash, 'reorder moves the layout hash');
    assert.notEqual(r.hash, a.hash, 'reorder moves the fingerprint hash');
    assert.equal(r.brandHash, a.brandHash, 'reorder leaves the brand half untouched');
    n += 3;

    // Brand sensitivity: change the heading font.
    const refont = fp.computeFingerprint({ theme: { ...THEME_BASE, headingFont: '"Nunito", sans-serif' }, pages: fixturePages() });
    assert.notEqual(refont.brandHash, a.brandHash, 'font change moves the brand hash');
    assert.notEqual(refont.hash, a.hash, 'font change moves the fingerprint hash');
    assert.equal(refont.layoutHash, a.layoutHash, 'font change leaves the layout half untouched');
    n += 3;

    // Degenerate models do not throw.
    const empty = fp.computeFingerprint({ theme: {}, pages: [] });
    assert.equal(empty.layout.homeSections.length, 0);
    assert.equal(empty.brand.fonts.heading, null);
    assert.ok(fp.computeFingerprint({}).hash, 'empty model still fingerprints');
    n += 3;

    group('Part 1 module units', n);
  }

  /* ================================================================== */
  /* Part 2 — colour distance + the double-match rule                    */
  /* ================================================================== */
  {
    let n = 0;
    assert.equal(fp.colourDistance('#1a56db', '#1a56db'), 0, 'identical colours: ΔE 0');
    const bw = fp.colourDistance('#000000', '#ffffff');
    assert.ok(bw > 95 && bw < 105, `black/white ΔE ≈ 100 (got ${bw})`);
    const step = fp.colourDistance('#1a56db', '#1a56dc');
    assert.ok(step != null && step < 2, `one-step shade ΔE < 2 (got ${step})`);
    assert.equal(fp.colourDistance('rebeccapurple', '#000000'), null, 'non-hex → null distance');
    n += 4;

    const base = fp.computeFingerprint(MODEL_BASE);
    const twin = fp.computeFingerprint(JSON.parse(JSON.stringify(MODEL_BASE)));
    const layoutOnly = fp.computeFingerprint({ theme: { ...THEME_BASE, headingFont: '"Nunito", sans-serif', primary: '#d97706' }, pages: fixturePages() });
    const brandOnlyPages = fixturePages().slice(0, 2); // drop the faq page → different slug set + same home
    const brandOnly = fp.computeFingerprint({ theme: THEME_BASE, pages: brandOnlyPages });
    const closePalette = fp.computeFingerprint({ theme: { ...THEME_BASE, primary: '#1a56dc' }, pages: fixturePages() });

    const cTwin = fp.compareFingerprints(base, twin);
    assert.equal(cTwin.doubleMatch, true, 'identical models double-match');
    assert.equal(cTwin.evidence.primaryDeltaE, 0);
    n += 2;
    const cLayout = fp.compareFingerprints(base, layoutOnly);
    assert.equal(cLayout.layoutMatch, true, 'layout-only: layout matches');
    assert.equal(cLayout.brandClose, false, 'layout-only: brand does not');
    assert.equal(cLayout.doubleMatch, false, 'layout-only never flags');
    n += 3;
    const cBrand = fp.compareFingerprints(base, brandOnly);
    assert.equal(cBrand.brandClose, true, 'brand-only: brand close');
    assert.equal(cBrand.layoutMatch, false, 'brand-only: layout does not match (page set differs)');
    assert.equal(cBrand.doubleMatch, false, 'brand-only never flags');
    n += 3;
    const cClose = fp.compareFingerprints(base, closePalette);
    assert.equal(cClose.doubleMatch, true, 'one-step palette shade still double-matches (ΔE under threshold)');
    n++;

    const entries = [
      { workspaceId: 1, websiteId: 11, name: 'A1', fingerprint: base },
      { workspaceId: 1, websiteId: 12, name: 'A2', fingerprint: twin },
      { workspaceId: 2, websiteId: 21, name: 'B1', fingerprint: twin },
      { workspaceId: 2, websiteId: 22, name: 'B2', fingerprint: layoutOnly },
      { workspaceId: 3, websiteId: 31, name: 'C1', fingerprint: brandOnly },
    ];
    const report = fp.similarityReport(entries);
    assert.equal(report.counts.sites, 5);
    assert.equal(report.flagged.length, 2, 'cross-workspace double matches flagged: A1-B1 and A2-B1');
    assert.ok(
      report.flagged.every((p) => Number(p.a.workspaceId) !== Number(p.b.workspaceId)),
      'flagged pairs are always cross-workspace'
    );
    assert.equal(report.sameClient.length, 1, 'the ws1 twin pair is same-client');
    assert.equal(report.sameClient[0].a.websiteId, 11);
    assert.equal(report.sameClient[0].b.websiteId, 12);
    n += 5;

    group('Part 2 colour distance + double-match', n);
  }

  /* ================================================================== */
  /* Part 3 — domain + MCP in-process                                    */
  /* ================================================================== */
  let WS_A;
  let WS_B;
  let SITE = {};
  {
    let n = 0;
    const platformDb = require(path.join(root, 'server/db.js'));
    await platformDb.migrate();
    const workspace = require(path.join(root, 'server/workspace.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const engine = require(path.join(root, 'src/websiteEngine.js'));
    const domain = require(path.join(root, 'server/domain.js'));

    const ua = await workspace.createUserWithWorkspace({
      email: 'a156@example.invalid',
      password: PW,
      name: 'A156',
      workspaceName: 'Batch156 WS A',
    });
    const ub = await workspace.createUserWithWorkspace({
      email: 'b156@example.invalid',
      password: PW,
      name: 'B156',
      workspaceName: 'Batch156 WS B',
    });
    WS_A = Number(ua.workspaceId);
    WS_B = Number(ub.workspaceId);

    const models = {
      base: MODEL_BASE,
      twin: JSON.parse(JSON.stringify(MODEL_BASE)),
      refont: { theme: { ...THEME_BASE, headingFont: '"Nunito", sans-serif' }, pages: fixturePages() },
    };
    const seedSite = (wsId, leadId, name, model) => {
      const db = openWorkspaceDb(wsId);
      engine.ensureTables(db);
      db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
        leadId,
        name,
        `lead${leadId}@example.invalid`,
        'customer'
      );
      const info = db
        .prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)')
        .run(leadId, `${name} Site`, JSON.stringify(model.theme), JSON.stringify(model.pages), 'draft');
      return Number(info.lastInsertRowid);
    };
    SITE.aBase = seedSite(WS_A, 15601, 'Alpha Plants', models.base);
    SITE.aTwin = seedSite(WS_A, 15602, 'Alpha Plants Two', models.twin);
    SITE.bTwin = seedSite(WS_B, 15603, 'Beta Plants', models.twin);
    SITE.bRefont = seedSite(WS_B, 15604, 'Beta Lawns', models.refont);

    const baseHash = fp.computeFingerprint(MODEL_BASE).hash;

    const got = domain.sitesGet(WS_A, SITE.aBase);
    assert.ok(got.fingerprint, 'sitesGet carries the fingerprint');
    assert.equal(got.fingerprint.hash, baseHash, 'sitesGet fingerprint = the module fingerprint');
    n += 2;

    const list = domain.sitesList(WS_A, {});
    const rowA = list.sites.find((s) => Number(s.id) === SITE.aBase);
    assert.equal(rowA.fingerprint_hash, baseHash, 'sitesList row carries the fingerprint hash');
    assert.ok(String(rowA.fingerprint_summary || '').includes('fraunces'), 'sitesList row carries the summary');
    assert.ok(!('theme' in rowA) && !('pages' in rowA), 'sitesList does not leak the raw model blobs');
    n += 3;

    const detail = await domain.siteFingerprintGet(WS_A, SITE.aBase);
    assert.equal(detail.fingerprint.hash, baseHash, 'siteFingerprintGet = the module fingerprint');
    assert.equal(detail.flaggedWith.length, 1, 'one flagged pair: the cross-workspace twin');
    assert.equal(detail.flaggedWith[0].b.websiteId, SITE.bTwin, 'flagged against the ws-B twin');
    assert.equal(detail.sameClientWith.length, 1, 'one same-client pair: the ws-A twin');
    assert.equal(detail.sameClientWith[0].b.websiteId, SITE.aTwin);
    n += 5;

    await assert.rejects(
      () => domain.siteFingerprintGet(WS_A, 999999),
      (e) => String((e && e.code) || (e && e.message) || e).includes('SITE_NOT_FOUND'),
      'unknown website id errors SITE_NOT_FOUND'
    );
    n++;

    const ledger = await domain.sitesFingerprintLedger();
    assert.equal(ledger.sites.length, 4, 'ledger lists every live site across workspaces');
    assert.equal(ledger.report.flagged.length, 2, 'ledger flags A-base × B-twin and A-twin × B-twin');
    assert.equal(ledger.report.sameClient.length, 1, 'ledger separates the same-client pair');
    n += 3;

    const mcp = require(path.join(root, 'server/mcp.js'));
    const defs = mcp.toolDefs();
    assert.equal(defs.filter((d) => d.name === 'website.fingerprint').length, 1, 'website.fingerprint registered exactly once');
    const viaMcp = await mcp.callTool(WS_A, 'website.fingerprint', { id: SITE.aBase }, {});
    assert.equal(viaMcp.ok, true, 'website.fingerprint dispatches');
    assert.equal(viaMcp.data.fingerprint.hash, baseHash, 'MCP fingerprint = the module fingerprint');
    assert.equal(viaMcp.data.flaggedWith.length, 1, 'MCP carries the flagged pairs');
    const viaMcpBad = await mcp.callTool(WS_A, 'website.fingerprint', { id: 999999 }, {});
    assert.equal(viaMcpBad.ok, false, 'MCP unknown id fails cleanly');
    n += 5;

    group('Part 3 domain + MCP in-process', n);
  }

  /* ================================================================== */
  /* Part 4 — render invariance (no renderer changes in this batch)      */
  /* ================================================================== */
  {
    let n = 0;
    const engine = require(path.join(root, 'src/websiteEngine.js'));
    const html = engine.renderSite(fixturePages(), THEME_BASE);
    const digest = crypto.createHash('sha256').update(html).digest('hex');
    assert.equal(
      digest,
      '7946e792f2231420c421261920a44fefa9ad92d94ad9604c4dbc39e4268a71b7',
      'fixture render is byte-identical to the Batch 155 tree output (fingerprint code changes no render path)'
    );
    n++;
    group('Part 4 render invariance', n);
  }

  /* ================================================================== */
  /* Part 5 — HTTP over the real server                                  */
  /* ================================================================== */
  if (process.env.B156_SKIP_HTTP !== '1') {
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
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      let res = await fetch(`${BASE}/api/v1/fingerprints`);
      assert.ok([401, 403].includes(res.status), 'ledger refuses unauthenticated: ' + res.status);
      res = await fetch(`${BASE}/api/v1/websites/${SITE.aBase}/fingerprint`);
      assert.ok([401, 403].includes(res.status), 'site fingerprint refuses unauthenticated: ' + res.status);
      n += 2;

      const login = async (jar, email, password) => {
        const postJ = (p, body) =>
          jar.fetch(BASE + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          });
        const totp = require(path.join(root, 'src', 'totp.js'));
        let r = await postJ('/api/v1/auth/login', { email, password });
        let b = await json(r);
        assert.equal(r.status, 200, 'login 200 for ' + email);
        if (b.data && b.data.mfaRequired === true) {
          r = await postJ('/api/v1/auth/mfa/enroll/start', {});
          b = await json(r);
          assert.ok(b.data && b.data.secret, 'enroll secret issued for ' + email);
          r = await postJ('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(b.data.secret) });
          b = await json(r);
          assert.equal(r.status, 200, 'MFA confirm 200 for ' + email);
        }
        return b;
      };

      // Workspace owner (not super admin): her own site yes, ledger no.
      const jarA = makeJar();
      await login(jarA, 'a156@example.invalid', PW);
      n++;
      res = await jarA.fetch(`${BASE}/api/v1/websites/${SITE.aBase}/fingerprint`);
      assert.equal(res.status, 200, 'owner reads her site fingerprint over HTTP');
      const detailBody = await json(res);
      assert.equal(detailBody.data.fingerprint.hash, fp.computeFingerprint(MODEL_BASE).hash, 'HTTP fingerprint = module fingerprint');
      assert.equal(detailBody.data.flaggedWith.length, 1, 'HTTP carries the flagged pair');
      n += 3;
      res = await jarA.fetch(`${BASE}/api/v1/fingerprints`);
      assert.equal(res.status, 403, 'ledger refuses a non-super-admin workspace owner');
      n++;

      // Bootstrap super admin: the full baseline.
      const jarRoot = makeJar();
      await login(jarRoot, process.env.BOOTSTRAP_EMAIL, process.env.BOOTSTRAP_PASSWORD);
      n++;
      res = await jarRoot.fetch(`${BASE}/api/v1/fingerprints`);
      assert.equal(res.status, 200, 'super admin reads the ledger');
      const ledgerBody = await json(res);
      assert.equal(ledgerBody.data.sites.length, 4, 'ledger lists the four fixture sites');
      assert.equal(ledgerBody.data.report.flagged.length, 2, 'ledger report flags the cross-workspace twins');
      assert.equal(ledgerBody.data.report.sameClient.length, 1, 'ledger report separates the same-client pair');
      n += 4;

      group('Part 5 HTTP over the real server', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  /* ================================================================== */
  /* Part 6 — source pins for the staff surface                          */
  /* ================================================================== */
  {
    let n = 0;
    const api = read('server/routes/domainApi.js');
    assert.ok(api.includes("router.get('/websites/:id/fingerprint'"), 'REST site fingerprint route');
    assert.ok(api.includes("router.get('/fingerprints', requireSuperAdmin"), 'REST ledger route is super-admin gated');
    n += 2;
    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes('async function pageFingerprints()'), 'ledger page exists');
    assert.ok(appJs.includes('fingerprintHtml'), 'detail card is built');
    assert.ok(appJs.includes('s.fingerprint_hash'), 'list column reads the row hash');
    assert.ok(appJs.includes("fingerprints: 'Site fingerprints'"), 'route label registered');
    n += 4;
    assert.ok(read('public/index.html').includes('#/fingerprints'), 'sidebar links the ledger');
    assert.ok(read('public/js/navGroups.js').includes("'fingerprints'"), 'nav groups register the route');
    assert.ok(read('public/js/api.js').includes('fingerprintsLedger'), 'api client carries the ledger call');
    n += 3;
    const domainSrc = read('server/domain.js');
    assert.ok(domainSrc.includes("require('./siteFingerprint')"), 'domain wires the fingerprint module');
    assert.ok(!read('server/siteFingerprint.js').includes('renderPage'), 'fingerprint module never touches a render path');
    n += 2;
    group('Part 6 source pins', n);
  }

  console.log(`BATCH156 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH156 REGRESSION FAIL:', (e && e.stack) || e);
  process.exit(1);
});
