'use strict';
/**
 * Batch 126 — QR CODE GENERATOR MODULE (Ely's order 2026-11-03: "Add a
 * photo capture and qr code generator module too", with his standing
 * interdependence rule restated for it: "they should be able to work
 * with all other modules").
 *
 * What is pinned here:
 *   Part 1 — registration + surfaces: qrcode is the 24th MODULE_TYPES
 *     member with meta + icon glyph; the Batch 122 shared-layer
 *     registry classifies it as a PROVIDER (registry ⇔ MODULE_TYPES
 *     parity at 24); MODULE_SCRIPT_VER bumped for the new embed
 *     renderer; portal lists/copy/nav/fields/panel, the embed renderer,
 *     and every agent surface (hosted MCP defs + plan gate + dispatch,
 *     design-agent tool fences, local catalog + parity CRUD) carry it.
 *   Part 2 — engine (in-process): CRUD + validation (bad URL/tel/email
 *     refused, WiFi SSID required, page targets must exist on the site,
 *     module targets must be attached); payload composition per target
 *     kind incl. WIFI: escaping; generation correctness proven by
 *     decoding the rendered PNG's module matrix back against the
 *     payload (pngjs + the qrcode package's own matrix) and by SVG
 *     byte-equality; REFERENCE resolution (rename the target page →
 *     the re-rendered payload follows; delete the target or detach the
 *     target module → dormant-empty public payload, never an error);
 *     module landings resolve for bookings + Google Reviews; the
 *     public image route resolution (token-scoped, published-only,
 *     cross-lead ids refused); the shared layer serving codes as
 *     uniform items; agent dispatch through mcp.callTool; the portal
 *     service layer (enriched list with real previews, WiFi password
 *     never in a list response, print downloads).
 *   Part 3 — HTTP over the real server: portal owner signs in, lists
 *     codes with targets, creates one through the generic module
 *     route, saves the on-site display choice, downloads PNG + SVG;
 *     the public payload serves the chosen code and the public image
 *     route serves a decodable PNG; anonymous is refused and a foreign
 *     code id 404s.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b126-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch126', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 24).toString('base64');

const PORT = 31486;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch126', 'fixture', 'password'].join('-');

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

/** Decode-check: the PNG's module matrix must equal the payload's. */
function assertPngEncodes(pngBuf, payload, ecLevel = 'M') {
  const { PNG } = require('pngjs');
  const QRCode = require('qrcode');
  const png = PNG.sync.read(pngBuf);
  const qr = QRCode.create(payload, { errorCorrectionLevel: ecLevel });
  const size = qr.modules.size;
  const cells = size + 2; // margin 1 on both sides
  const cell = png.width / cells;
  let mismatches = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.floor((x + 1.5) * cell);
      const py = Math.floor((y + 1.5) * cell);
      const dark = png.data[(py * png.width + px) * 4] < 128;
      if (dark !== (qr.modules.data[y * size + x] === 1)) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `rendered PNG decodes back to the payload (${size}x${size} modules)`);
}

const LEAD_A = 12601;
const LEAD_B = 12602;
const SITE_A = 'https://alpha126.pages.dev';
let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — registration + surfaces                                    */
  /* ================================================================== */
  {
    let n = 0;
    const share = require(path.join(root, 'server/moduleShare.js'));
    const sm = require(path.join(root, 'server/siteModules.js'));

    assert.equal(sm.MODULE_TYPES.length, 24, 'qrcode is the 24th module type');
    n++;
    assert.equal(sm.MODULE_TYPES[23], 'qrcode', 'qrcode registered last (append-only catalog)');
    n++;
    assert.equal(sm.MODULE_META.qrcode.label, 'QR Code');
    n++;
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod26', 'embed script version bumped for the QR renderer');
    n++;
    // Registry parity at 24 + the qrcode classification.
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'share registry still covers every module type exactly'
    );
    n++;
    assert.equal(share.SHARE_REGISTRY.qrcode.kind, 'provider', 'qrcode is a shared-layer provider');
    n++;

    const icons = read('public/js/moduleIcons.js');
    assert.ok(icons.includes('qrcode:'), 'module icon glyph for qrcode');
    n++;
    const portalJs = read('public/js/portal.js');
    for (const pin of [
      "{ type: 'qrcode', label: 'QR Code' }",
      'qrcode: { singular',
      'renderQrCodePanel',
      "'/modules/qrcode/display'",
      'modules/qrcode/${it.id}/download',
    ]) {
      assert.ok(portalJs.includes(pin), `portal.js carries ${pin}`);
      n++;
    }
    assert.ok(read('public/portal.html').includes('modules-qrcode-panel'), 'portal.html hosts the QR panel');
    n++;
    assert.ok(
      read('public/portal.html').includes('/js/portal.js?v=batch126-qrcode1'),
      'portal.js cache-busted for Batch 126'
    );
    n++;
    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes("type === 'qrcode'") && embed.includes('qrCodeHtml'), 'embed renders the QR module');
    n++;
    const mcp = read('server/mcp.js');
    for (const pin of [
      "name: 'qrcode.list'",
      "name: 'qrcode.create'",
      "'qrcode.update'",
      "'qrcode.delete'",
      "name === 'qrcode.create'",
    ]) {
      assert.ok(mcp.includes(pin), `hosted MCP carries ${pin}`);
      n++;
    }
    const fences = read('server/museAgentTools.js');
    assert.ok(fences.includes("'qrcode.list'"), 'agent read fence carries qrcode.list');
    n++;
    assert.ok(
      fences.includes("'qrcode.create', 'qrcode.update', 'qrcode.delete'"),
      'agent write fence carries qrcode CRUD'
    );
    n++;
    assert.ok(read('src/mcpCatalog.js').includes("name: 'qrcode.create'"), 'local catalog carries qrcode defs');
    n++;
    assert.ok(read('src/mcpParityTools.js').includes("moduleCrud('qrcode'"), 'local parity carries qrcode CRUD');
    n++;
    assert.ok(read('server/portalSiteChat.js').includes('QR codes:'), 'design-chat census carries the QR line');
    n++;
    assert.ok(read('server/routes/portal.js').includes("['qrcode', 'qrcode']"), 'portal subpath gating maps qrcode');
    n++;
    assert.ok(
      read('server/clientPortal.js').includes('saveQrCodeDisplaySettings: portalModules.saveQrCodeDisplaySettings'),
      'clientPortal facade re-exports the QR display/download services'
    );
    n++;
    assert.ok(read('server/routes/modulesPublic.js').includes('qrcode/:file'), 'public image route exists');
    n++;
    group('Part 1 registration + surfaces', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process)                                        */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const share = require(path.join(root, 'server/moduleShare.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a126@example.invalid',
    password: ['batch126', 'ws', 'password'].join('-'),
    name: 'A126',
    workspaceName: 'Batch126 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a126@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B126 Alpha Cuts', 'alpha126@example.invalid'],
    [LEAD_B, 'B126 Beta Lawns', 'beta126@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }
  const pagesA = [
    { slug: 'index', title: 'Home' },
    { slug: 'about', title: 'About Us' },
    { slug: 'visit', title: 'Visit Us' },
  ];
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    LEAD_A,
    'Alpha Site',
    '{}',
    JSON.stringify(pagesA),
    'live',
    `${SITE_A}/`
  );
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    LEAD_B,
    'Beta Site',
    '{}',
    JSON.stringify([
      { slug: 'index', title: 'Home' },
      { slug: 'menu-page', title: 'Beta Menu' },
    ]),
    'live',
    'https://beta126.pages.dev/'
  );
  // Module landings on lead A: bookings + Google Reviews attached & live;
  // menu deliberately NOT attached (validation target).
  sm.attachModule(db, LEAD_A, 'bookings', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_A, 'googlereviews', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_A, 'qrcode', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_B, 'bookings', { workspaceId: WS_ID });

  // ---- 2a CRUD + validation + payload composition ----
  let codeAbout, codeHome, codeBook, codeReviews, codeWifi, codeVisit;
  {
    let n = 0;
    codeAbout = sm.createQrCode(db, LEAD_A, {
      name: 'About (counter card)',
      target_kind: 'page',
      target_page: 'about',
      status: 'published',
    });
    assert.equal(codeAbout.target_ref, 'about');
    n++;
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeAbout), `${SITE_A}/about`, 'page target resolves to the live URL');
    n++;
    codeHome = sm.createQrCode(db, LEAD_A, {
      name: 'Home',
      target_kind: 'page',
      target_page: 'index',
      status: 'published',
    });
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeHome), `${SITE_A}/`, 'the home page resolves to the site root');
    n++;
    codeBook = sm.createQrCode(db, LEAD_A, {
      name: 'Scan to book',
      target_kind: 'module',
      target_module: 'bookings',
      status: 'published',
    });
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeBook),
      `${SITE_A}/book`,
      'bookings landing resolves through module URL composition'
    );
    n++;
    codeReviews = sm.createQrCode(db, LEAD_A, {
      name: 'Review us',
      target_kind: 'module',
      target_module: 'googlereviews',
      status: 'published',
    });
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeReviews),
      `${SITE_A}/reviews`,
      'Google Reviews landing resolves too'
    );
    n++;
    const urlCode = sm.createQrCode(db, LEAD_A, {
      name: 'Ext',
      target_kind: 'url',
      target_value: 'https://example.com/menu?x=1',
      status: 'published',
    });
    assert.equal(sm.buildQrPayload(db, LEAD_A, urlCode), 'https://example.com/menu?x=1');
    n++;
    const telCode = sm.createQrCode(db, LEAD_A, {
      name: 'Call',
      target_kind: 'tel',
      target_value: '+1 (610) 555-0134',
      status: 'draft',
    });
    assert.equal(telCode.target_ref, '+16105550134', 'tel targets normalize to dialable form');
    n++;
    assert.equal(sm.buildQrPayload(db, LEAD_A, telCode), 'tel:+16105550134');
    n++;
    const mailCode = sm.createQrCode(db, LEAD_A, {
      name: 'Mail',
      target_kind: 'email',
      target_value: 'hello@alpha126.example',
      status: 'draft',
    });
    assert.equal(sm.buildQrPayload(db, LEAD_A, mailCode), 'mailto:hello@alpha126.example');
    n++;
    codeWifi = sm.createQrCode(db, LEAD_A, {
      name: 'Guest WiFi',
      target_kind: 'wifi',
      wifi_ssid: 'Cafe;Net "5G"',
      wifi_auth: 'WPA',
      wifi_password: 'p\\ss,word:1',
      wifi_hidden: 1,
      status: 'published',
    });
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeWifi),
      'WIFI:T:WPA;S:Cafe\\;Net \\"5G\\";P:p\\\\ss\\,word\\:1;H:true;;',
      'WIFI payload escapes ; , " : and backslash (ZXing field rules)'
    );
    n++;
    const openWifi = sm.createQrCode(db, LEAD_A, {
      name: 'Open WiFi',
      target_kind: 'wifi',
      wifi_ssid: 'Porch',
      wifi_auth: 'nopass',
      status: 'draft',
    });
    assert.equal(sm.buildQrPayload(db, LEAD_A, openWifi), 'WIFI:T:nopass;S:Porch;;', 'nopass WiFi carries no P field');
    n++;

    const refused = (data, lead = LEAD_A) =>
      assert.throws(
        () => sm.createQrCode(db, lead, data),
        (e) => e.code === 'VALIDATION'
      );
    refused({ name: 'Bad URL', target_kind: 'url', target_value: 'ftp://example.com' });
    n++;
    refused({ name: 'Bad URL 2', target_kind: 'url', target_value: 'not a url' });
    n++;
    refused({ name: 'Bad tel', target_kind: 'tel', target_value: '123' });
    n++;
    refused({ name: 'Bad mail', target_kind: 'email', target_value: 'nope@' });
    n++;
    refused({ name: 'No SSID', target_kind: 'wifi', wifi_ssid: '  ' });
    n++;
    refused({ name: 'Ghost page', target_kind: 'page', target_page: 'no-such-page' });
    n++;
    refused({ name: 'Unattached module', target_kind: 'module', target_module: 'menu' });
    n++;
    refused({ name: 'Self target', target_kind: 'module', target_module: 'qrcode' });
    n++;
    refused({ name: 'Foreign page', target_kind: 'page', target_page: 'menu-page' });
    n++;
    assert.throws(
      () => sm.createQrCode(db, LEAD_A, { target_kind: 'url', target_value: 'https://x.example' }),
      /name is required/
    );
    n++;

    // Cross-lead reads/writes refused.
    assert.equal(sm.getQrCode(db, LEAD_B, codeAbout.id), null, "another lead's code never resolves");
    n++;
    assert.throws(
      () => sm.updateQrCode(db, LEAD_B, codeAbout.id, { name: 'Hijack' }),
      (e) => e.code === 'NOT_FOUND'
    );
    n++;
    assert.throws(
      () => sm.deleteQrCode(db, LEAD_B, codeAbout.id),
      (e) => e.code === 'NOT_FOUND'
    );
    n++;
    // Update keeps WiFi password on blank (editor round-trip discipline).
    const renamed = sm.updateQrCode(db, LEAD_A, codeWifi.id, { name: 'Guest WiFi (lobby)', wifi_password: '' });
    assert.equal(renamed.name, 'Guest WiFi (lobby)');
    n++;
    assert.ok(
      sm.buildQrPayload(db, LEAD_A, renamed).includes('P:p\\\\ss'),
      'blank password on update keeps the stored one'
    );
    n++;
    group('Part 2a CRUD + validation + payloads', n);
  }

  // ---- 2b generation correctness (decode the rendered image back) ----
  {
    let n = 0;
    const payload = sm.buildQrPayload(db, LEAD_A, codeAbout);
    const png = await sm.renderQrCodeImage(payload, codeAbout, { format: 'png' });
    assert.equal(png.contentType, 'image/png');
    n++;
    assertPngEncodes(Buffer.from(png.body), payload, 'M');
    n++;
    const wifiPayload = sm.buildQrPayload(db, LEAD_A, codeWifi);
    const wifiPng = await sm.renderQrCodeImage(wifiPayload, codeWifi, { format: 'png', width: 1024 });
    assertPngEncodes(Buffer.from(wifiPng.body), wifiPayload, 'M');
    n++;
    const QRCode = require('qrcode');
    const svg = await sm.renderQrCodeImage(payload, codeAbout, { format: 'svg' });
    assert.equal(svg.contentType, 'image/svg+xml');
    n++;
    const direct = await QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: { dark: codeAbout.fg_color, light: codeAbout.bg_color },
    });
    assert.equal(String(svg.body), direct, 'SVG output is the package render of the resolved payload (deterministic)');
    n++;
    group('Part 2b generation correctness (PNG matrix decode-back + SVG)', n);
  }

  // ---- 2c reference resolution: rename follows, vanish goes dormant ----
  {
    let n = 0;
    codeVisit = sm.createQrCode(db, LEAD_A, {
      name: 'Visit us',
      target_kind: 'page',
      target_page: 'visit',
      status: 'published',
    });
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeVisit), `${SITE_A}/visit`);
    n++;
    // Rename the About page: the stored code's payload must follow.
    const renamedPages = pagesA.map((p) => (p.slug === 'about' ? { ...p, slug: 'about-us' } : p));
    db.prepare('UPDATE websites SET pages = ? WHERE lead_id = ?').run(JSON.stringify(renamedPages), LEAD_A);
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeAbout),
      `${SITE_A}/about-us`,
      'renaming the target page moves the code (reference, not a baked URL)'
    );
    n++;
    // Delete the Visit page: resolution goes dormant.
    const withoutVisit = renamedPages.filter((p) => p.slug !== 'visit');
    db.prepare('UPDATE websites SET pages = ? WHERE lead_id = ?').run(JSON.stringify(withoutVisit), LEAD_A);
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeVisit), '', 'a vanished page target resolves empty');
    n++;
    // Choose the dormant code for the site display: public payload omits it.
    sm.updateQrCodeDisplay(db, LEAD_A, { qrcode_id: codeVisit.id, caption: 'Scan to visit' }, { workspaceId: WS_ID });
    const qrEmbed = sm.getEmbedRow(db, LEAD_A, 'qrcode');
    const dormantPayload = sm.getPublicModuleByToken(db, qrEmbed.public_token);
    assert.equal(dormantPayload.qrcode, undefined, 'dormant code: no qrcode block in the public payload');
    n++;
    assert.equal((dormantPayload.items || []).length, 0, 'dormant code: payload items stay empty');
    n++;
    // Choose a live code: the block serves, resolved at serve time.
    sm.updateQrCodeDisplay(db, LEAD_A, { qrcode_id: codeBook.id, caption: 'Scan to book' }, { workspaceId: WS_ID });
    const livePayload = sm.getPublicModuleByToken(db, qrEmbed.public_token);
    assert.ok(livePayload.qrcode, 'the chosen live code serves a qrcode block');
    n++;
    assert.equal(livePayload.qrcode.target_url, `${SITE_A}/book`, 'public block target follows module composition');
    n++;
    assert.ok(
      livePayload.qrcode.image_url.endsWith(`/qrcode/${codeBook.id}.png`),
      'public block image points at the image route'
    );
    n++;
    assert.equal(livePayload.qrcode.caption, 'Scan to book');
    n++;
    // Re-slugging a module landing moves its codes (the reference is
    // the module type; the slug is read from the live embed each time).
    db.prepare(
      "UPDATE site_module_embeds SET target_page_slug = 'about-us' WHERE lead_id = ? AND module_type = 'bookings'"
    ).run(LEAD_A);
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeBook),
      `${SITE_A}/about-us`,
      'module codes follow a landing re-slug'
    );
    n++;
    db.prepare(
      "UPDATE site_module_embeds SET target_page_slug = 'book' WHERE lead_id = ? AND module_type = 'bookings'"
    ).run(LEAD_A);
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeBook), `${SITE_A}/book`);
    n++;
    // Renaming BOTH the slug and the title leaves nothing safe to
    // follow — dormant, never a guess at a different page.
    const fullyRenamed = withoutVisit.map((p) =>
      p.slug === 'about-us' ? { slug: 'our-story', title: 'Our Story' } : p
    );
    db.prepare('UPDATE websites SET pages = ? WHERE lead_id = ?').run(JSON.stringify(fullyRenamed), LEAD_A);
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeAbout), '', 'slug+title both renamed resolves dormant (fail-safe)');
    n++;
    db.prepare('UPDATE websites SET pages = ? WHERE lead_id = ?').run(JSON.stringify(withoutVisit), LEAD_A);
    assert.equal(
      sm.buildQrPayload(db, LEAD_A, codeAbout),
      `${SITE_A}/about-us`,
      'restoring the page restores the code'
    );
    n++;
    // Detaching the target module makes its code dormant too.
    sm.detachModule(db, LEAD_A, 'googlereviews');
    assert.equal(sm.buildQrPayload(db, LEAD_A, codeReviews), '', 'detached module target resolves empty');
    n++;
    // Public image route resolution: strict + published-only + isolated.
    const resolved = sm.resolvePublicQrCode(db, qrEmbed.public_token, codeBook.id);
    assert.equal(resolved.payload, `${SITE_A}/book`);
    n++;
    const draftCode = sm.createQrCode(db, LEAD_A, {
      name: 'Draft code',
      target_kind: 'url',
      target_value: 'https://draft.example',
      status: 'draft',
    });
    assert.throws(
      () => sm.resolvePublicQrCode(db, qrEmbed.public_token, draftCode.id),
      (e) => e.code === 'NOT_FOUND'
    );
    n++;
    const betaCode = sm.createQrCode(db, LEAD_B, {
      name: 'Beta book',
      target_kind: 'module',
      target_module: 'bookings',
      status: 'published',
    });
    assert.throws(
      () => sm.resolvePublicQrCode(db, qrEmbed.public_token, betaCode.id),
      (e) => e.code === 'NOT_FOUND'
    );
    n++;
    group('Part 2c reference resolution + dormant discipline', n);
  }

  // ---- 2d the shared layer serves codes like any other content ----
  {
    let n = 0;
    const sources = share.listSharedSources(db, LEAD_A, { sample: 0 });
    const qrSource = sources.find((s) => s.type === 'qrcode');
    assert.equal(qrSource.kind, 'provider');
    n++;
    const items = share.listSharedItems(db, LEAD_A, 'qrcode');
    const names = items.map((i) => i.title);
    assert.ok(names.includes('Scan to book'), 'published module-target code is shared');
    n++;
    assert.ok(!names.includes('Draft code'), 'draft codes never enter the shared layer');
    n++;
    assert.ok(!names.includes('Visit us'), 'codes with vanished targets stay out of the shared layer');
    n++;
    const bookItem = items.find((i) => i.title === 'Scan to book');
    assert.equal(bookItem.source_type, 'qrcode');
    n++;
    assert.equal(bookItem.link_url, `${SITE_A}/book`, 'shared item link is the resolved target');
    n++;
    assert.ok(bookItem.image_url.includes(`/qrcode/${codeBook.id}.png`), 'shared item image is the public code image');
    n++;
    const wifiItem = items.find((i) => i.title.startsWith('Guest WiFi'));
    assert.ok(wifiItem, 'WiFi codes share as items too (their payload IS the content)');
    n++;
    const betaItems = share.listSharedItems(db, LEAD_B, 'qrcode');
    assert.ok(
      betaItems.every((i) => i.title !== 'Scan to book'),
      "lead B's shared items never include lead A's codes"
    );
    n++;
    group('Part 2d shared-layer provider output', n);
  }

  // ---- 2e agent dispatch + portal service layer ----
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const created = await mcp.callTool(
      WS_ID,
      'qrcode.create',
      {
        leadId: LEAD_A,
        name: 'Agent-made reviews code',
        target_kind: 'module',
        target_module: 'bookings',
        status: 'published',
      },
      {}
    );
    assert.equal(created.ok, true, 'agent qrcode.create dispatches');
    const createdCode = created.data && created.data.qrcode;
    assert.ok(createdCode && createdCode.id, 'agent qrcode.create returns the code');
    n++;
    const listed = await mcp.callTool(WS_ID, 'qrcode.list', { leadId: LEAD_A }, {});
    const rows = (listed.data && listed.data.qrcodes) || [];
    assert.ok(
      rows.some((r) => r.name === 'Agent-made reviews code' && r.payload === `${SITE_A}/book`),
      'agent list carries resolved payloads'
    );
    n++;
    assert.ok(
      rows.every((r) => !('wifi_password' in r) || r.wifi_password === undefined),
      'agent list never echoes the WiFi password'
    );
    n++;

    const portalModules = require(path.join(root, 'server/portalModules.js'));
    const ownerEmail = 'a126@example.invalid';
    const list = await portalModules.listModuleItems(WS_ID, LEAD_A, 'qrcode', ownerEmail);
    const wifiRow = list.items.find((i) => i.target_kind === 'wifi');
    assert.ok(
      wifiRow.image_data_url.startsWith('data:image/png;base64,'),
      'portal list carries a real rendered preview'
    );
    n++;
    assert.equal(wifiRow.wifi_password, undefined, 'portal list never carries the WiFi password');
    n++;
    assert.equal(wifiRow.has_wifi_password, true, 'portal list flags that a WiFi password is set');
    n++;
    assert.ok(
      list.qrcode.targets.pages.some((p) => p.slug === 'about-us'),
      'picker data is the real (renamed) page list'
    );
    n++;
    assert.ok(
      list.qrcode.targets.modules.some((m) => m.type === 'bookings'),
      'picker data lists attached module landings'
    );
    n++;
    assert.ok(
      !list.qrcode.targets.modules.some((m) => m.type === 'menu'),
      'unattached modules are not offered as targets'
    );
    n++;
    const dl = await portalModules.downloadQrCode(WS_ID, LEAD_A, codeAbout.id, 'png', ownerEmail);
    assert.equal(dl.contentType, 'image/png');
    n++;
    assert.ok(
      Buffer.from(dl.body)
        .subarray(0, 4)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      'download is a real PNG'
    );
    n++;
    assertPngEncodes(Buffer.from(dl.body), `${SITE_A}/about-us`, 'M');
    n++;
    const dlSvg = await portalModules.downloadQrCode(WS_ID, LEAD_A, codeAbout.id, 'svg', ownerEmail);
    assert.equal(dlSvg.contentType, 'image/svg+xml');
    n++;
    await assert.rejects(
      () => portalModules.downloadQrCode(WS_ID, LEAD_A, codeVisit.id, 'png', ownerEmail),
      (e) => e.code === 'NOT_FOUND',
      'downloading a code whose target vanished is a 404, not a stale image'
    );
    n++;
    group('Part 2e agent dispatch + portal service layer', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner126@example.invalid',
      h: bcrypt.hashSync('UnusedPass126!', 12),
      n: 'B126 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner126@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B126 Alpha Cuts' }
    );

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

      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
      const owner = makeJar();
      {
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner126@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/qrcode`);
        assert.equal(res.status, 401, 'anonymous QR list refused');
        n++;
      }
      let httpCodeId;
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/qrcode`);
        assert.equal(res.status, 200, 'QR list over HTTP');
        const data = await json(res);
        const payload = data.data || data;
        assert.ok(Array.isArray(payload.items) && payload.items.length >= 3, 'list carries the fixture codes');
        assert.ok(payload.qrcode && payload.qrcode.targets.pages.length >= 2, 'list carries picker targets');
        n += 3;
      }
      {
        const res = await post(owner, '/api/v1/portal/modules/qrcode', {
          name: 'HTTP-made code',
          target_kind: 'url',
          target_value: 'https://http126.example/landing',
          status: 'published',
        });
        assert.equal(res.status, 200, 'generic module route creates a code');
        const data = await json(res);
        httpCodeId = ((data.data || data).item || {}).id;
        assert.ok(httpCodeId, 'created code id returned');
        n += 2;
      }
      {
        const res = await put(owner, '/api/v1/portal/modules/qrcode/display', {
          qrcode_id: httpCodeId,
          caption: 'Scan me',
        });
        assert.equal(res.status, 200, 'display choice saves');
        const data = await json(res);
        assert.equal(Number(((data.data || data).settings || {}).qrcode_id), Number(httpCodeId));
        n += 2;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/qrcode/${codeAbout.id}/download?format=png`);
        assert.equal(res.status, 200, 'PNG download over HTTP');
        assert.match(res.headers.get('content-type') || '', /image\/png/, 'PNG content type');
        assert.match(res.headers.get('content-disposition') || '', /attachment/, 'download disposition');
        const buf = Buffer.from(await res.arrayBuffer());
        assertPngEncodes(buf, `${SITE_A}/about-us`, 'M');
        n += 4;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/qrcode/${codeAbout.id}/download?format=svg`);
        assert.equal(res.status, 200, 'SVG download over HTTP');
        assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/, 'SVG content type');
        n += 2;
      }
      // Public flow: payload block + decodable image + foreign id 404.
      const qrEmbed = sm.getEmbedRow(db, LEAD_A, 'qrcode');
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${qrEmbed.public_token}`);
        assert.equal(res.status, 200, 'public payload over HTTP');
        const data = await json(res);
        const block = (data.data || data).qrcode;
        assert.ok(block && block.name === 'HTTP-made code', 'public payload serves the HTTP-chosen code');
        assert.equal(block.caption, 'Scan me');
        n += 3;
      }
      {
        const res = await fetch(`${BASE}/api/v1/modules/public/${qrEmbed.public_token}/qrcode/${httpCodeId}.png`);
        assert.equal(res.status, 200, 'public image route serves');
        assert.match(res.headers.get('content-type') || '', /image\/png/);
        assertPngEncodes(Buffer.from(await res.arrayBuffer()), 'https://http126.example/landing', 'M');
        n += 3;
      }
      {
        const betaCode = sm.listQrCodes(db, LEAD_B)[0];
        const res = await fetch(`${BASE}/api/v1/modules/public/${qrEmbed.public_token}/qrcode/${betaCode.id}.png`);
        assert.equal(res.status, 404, "another lead's code id under this token is a 404");
        n++;
      }
      group('Part 3 HTTP portal + public flow', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH126 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH126 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
