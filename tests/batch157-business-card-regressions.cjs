'use strict';
/**
 * Batch 157 — BUSINESS CARD in the claim kit (plan Phase 8; Ely's order
 * 2026-11-07 "Build both now", default D8: the card QR targets the
 * view-site URL).
 *
 * The claim kit already builds a 6×4 postcard PDF (src/claimKit.js).
 * This batch adds its second print piece: a standard 3.5×2in business
 * card carrying the business's NAME, ADDRESS (lead record exactly as
 * stored — never invented, omitted gracefully when absent), LOGO (the
 * site's stored logo image when one exists; a clean typeset name
 * otherwise) and ONE QR code to the site.
 *
 * What is pinned here:
 *   Part 1 — surfaces: claimKit exports the builders; domain exposes
 *     sitesBusinessCard/leadsBusinessCard; both REST routes exist with
 *     the postcard's auth scopes; api.js + app.js carry the download
 *     affordances exactly where the postcard is offered (lead drawer +
 *     website detail); the vendored jsQR decoder decodes a control QR.
 *   Part 2 — engine (in-process, tenant-shaped DB): the card PDF is
 *     exactly 252×144pt, one page; the filename is
 *     bitpype-businesscard-<slug>-<leadId>.pdf; address lines assemble
 *     from the stored columns and render; a stored PNG logo embeds
 *     (hasLogo) while text-mode / missing / unembeddable logos fall
 *     back to the typeset name without breaking the card; a lead with
 *     no address prints no address lines; no site URL → NO_SITE_URL;
 *     a website from another lead → MISMATCH; THE QR PROOF: the QR
 *     image embedded in the served PDF is extracted and decoded with
 *     jsQR (tests/vendor/jsQR.js, Apache-2.0) and must equal the exact
 *     view-site URL — the branded-sticker lesson: never ship an
 *     unverified code. The postcard path is regression-checked
 *     (432×288 PDF, postcard filename) in the same fixtures.
 *   Part 3 — HTTP over the real server: both card routes refuse
 *     anonymous callers; a staff session creates a lead, generates its
 *     site, and downloads the card by website id AND by lead id — 200,
 *     application/pdf, the claim kit's filename, and the embedded QR
 *     decodes to the very siteUrl the claim kit reports; an unknown
 *     website id returns a coded error, never a PDF.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b157-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch157', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b157@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['batch157', 'bootstrap', 'pw'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B157 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';

const PORT = 31557;
const BASE = `http://127.0.0.1:${PORT}`;

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

/* Extract every embedded image stream from a pdfkit PDF, decode the
 * first one that jsQR recognises, and return its payload. pdfkit stores
 * PNG images as FlateDecode DeviceRGB (colour) or DeviceGray data —
 * both shapes are tried; an opaque alpha SMask never decodes, which is
 * fine, it is simply skipped. */
function decodeAllQrsFromPdf(pdf) {
  const jsQR = require(path.join(root, 'tests/vendor/jsQR.js'));
  const text = pdf.toString('latin1');
  const found = [];
  let idx = 0;
  while (true) {
    const s = pdf.indexOf('stream\n', idx);
    if (s < 0) return found;
    const e = pdf.indexOf('endstream', s);
    if (e < 0) return found;
    const dict = text.slice(Math.max(0, s - 500), s);
    const wAll = dict.match(/\/Width (\d+)/g);
    const hAll = dict.match(/\/Height (\d+)/g);
    const w = wAll ? +wAll[wAll.length - 1].split(' ')[1] : 0;
    const h = hAll ? +hAll[hAll.length - 1].split(' ')[1] : 0;
    try {
      const inf = zlib.inflateSync(pdf.slice(s + 7, e - 1));
      if (w && h && (inf.length === w * h * 3 || inf.length === w * h)) {
        const px = inf.length === w * h * 3 ? 3 : 1;
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          rgba[i * 4] = inf[i * px];
          rgba[i * 4 + 1] = inf[i * px + (px === 3 ? 1 : 0)];
          rgba[i * 4 + 2] = inf[i * px + (px === 3 ? 2 : 0)];
          rgba[i * 4 + 3] = 255;
        }
        const r = jsQR(rgba, w, h);
        if (r && r.data) found.push(r.data);
      }
    } catch {
      /* not a flate image stream */
    }
    idx = e + 9;
  }
  return found;
}
function decodeQrFromPdf(pdf) {
  const all = decodeAllQrsFromPdf(pdf);
  return all.length ? all[0] : null;
}

/* pdfkit writes card text as hex segments inside TJ arrays; decode
 * every hex segment in every inflated stream and concatenate. */
function pdfPlainText(pdf) {
  const text = pdf.toString('latin1');
  let out = '';
  let idx = 0;
  const hexes = [];
  while (true) {
    const s = pdf.indexOf('stream\n', idx);
    if (s < 0) break;
    const e = pdf.indexOf('endstream', s);
    if (e < 0) break;
    try {
      const inf = zlib.inflateSync(pdf.slice(s + 7, e - 1)).toString('latin1');
      for (const m of inf.matchAll(/<([0-9a-fA-F]{2,})>/g)) hexes.push(m[1]);
    } catch {
      /* image streams are binary noise here */
    }
    idx = e + 9;
  }
  for (const hx of hexes) {
    try {
      out += Buffer.from(hx, 'hex').toString('latin1');
    } catch {
      /* skip */
    }
  }
  return out;
}

(async () => {
  /* ================================================================== */
  /* Part 1 — surfaces                                                   */
  /* ================================================================== */
  {
    let n = 0;
    const claimKit = require(path.join(root, 'src/claimKit.js'));
    for (const fn of ['buildBusinessCardPdf', 'buildBusinessCard', 'businessCardAddressLines']) {
      assert.equal(typeof claimKit[fn], 'function', `claimKit exports ${fn}`);
      n++;
    }
    const domainSrc = read('server/domain.js');
    assert.ok(domainSrc.includes('async function sitesBusinessCard('), 'domain.sitesBusinessCard defined');
    n++;
    assert.ok(domainSrc.includes('async function leadsBusinessCard('), 'domain.leadsBusinessCard defined');
    n++;
    assert.ok(/sitesBusinessCard,\s*\n\s*leadsBusinessCard,/.test(domainSrc), 'domain exports both card functions');
    n++;
    const apiSrc = read('server/routes/domainApi.js');
    assert.ok(apiSrc.includes("router.get('/websites/:id/business-card', scopeWebsite"), 'website card route, postcard scope');
    n++;
    assert.ok(apiSrc.includes("router.get('/leads/:id/business-card', scopeLeadParam"), 'lead card route, postcard scope');
    n++;
    const apiJs = read('public/js/api.js');
    assert.ok(apiJs.includes("websiteBusinessCard: async (id)"), 'api.js websiteBusinessCard');
    n++;
    assert.ok(apiJs.includes("leadBusinessCard: async (leadId)"), 'api.js leadBusinessCard');
    n++;
    assert.ok(apiJs.includes("'/websites/' + id + '/business-card'"), 'api.js website card endpoint');
    n++;
    assert.ok(apiJs.includes("'/leads/' + leadId + '/business-card'"), 'api.js lead card endpoint');
    n++;
    const appJs = read('public/js/app.js');
    assert.equal(appJs.split('data-act="business-card"').length - 1, 2, 'Business card button in BOTH postcard spots (lead drawer + website detail)');
    n++;
    assert.equal(appJs.split("'business-card': async () =>").length - 1, 2, 'business-card handler in both action maps');
    n++;
    assert.ok(appJs.includes('api.leadBusinessCard(id)') && appJs.includes('api.websiteBusinessCard(id)'), 'handlers call the api downloaders');
    n++;
    // The vendored real decoder must decode a control QR.
    const QRCode = require('qrcode');
    const { PNG } = require('pngjs');
    const jsQR = require(path.join(root, 'tests/vendor/jsQR.js'));
    const control = 'https://bitpype.test/control-157';
    const pngBuf = await QRCode.toBuffer(control, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 320 });
    const png = PNG.sync.read(pngBuf);
    const rgba = new Uint8ClampedArray(png.width * png.height * 4);
    rgba.set(png.data);
    const decoded = jsQR(rgba, png.width, png.height);
    assert.ok(decoded && decoded.data === control, 'vendored jsQR decodes a control QR exactly');
    n++;
    group('Part 1 surfaces + decoder control', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process)                                        */
  /* ================================================================== */
  {
    let n = 0;
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      Database = require('node:sqlite').DatabaseSync;
    }
    const db = new Database(':memory:');
    db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
    require(path.join(root, 'src/websiteEngine')).ensureTables(db);
    require(path.join(root, 'src/leadEngine')).ensureLeadColumns(db);
    const claimKit = require(path.join(root, 'src/claimKit.js'));

    // Address-line assembly units.
    assert.deepEqual(
      claimKit.businessCardAddressLines({ address: ' 412 Maple Street ', city: 'Reading', state: 'PA', postal_code: '19601' }),
      ['412 Maple Street', 'Reading, PA 19601']
    );
    n++;
    assert.deepEqual(claimKit.businessCardAddressLines({ city: 'Reading' }), ['Reading']);
    n++;
    assert.deepEqual(claimKit.businessCardAddressLines({ state: 'PA', zip: '19601' }), ['PA 19601']);
    n++;
    assert.deepEqual(claimKit.businessCardAddressLines({}), []);
    n++;
    assert.deepEqual(claimKit.businessCardAddressLines(null), []);
    n++;

    const SITE_URL = 'https://card157.pages.dev/';
    // Full fixture: address + image logo on disk in the canonical folder.
    const info = db
      .prepare(
        `INSERT INTO leads (business_name, email, status, address, city, state, postal_code, category)
         VALUES (?, '', 'new', ?, ?, ?, ?, ?)`
      )
      .run('Maple & Main Bakery', '412 Maple Street', 'Reading', 'PA', '19601', 'Bakery');
    const leadId = Number(info.lastInsertRowid);
    const theme = JSON.stringify({ logoMode: 'image', logoUrl: 'images/logo.png' });
    const sinfo = db
      .prepare(`INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, ?, ?, '[]', 'draft', ?)`)
      .run(leadId, 'Maple & Main Bakery', theme, SITE_URL);
    const siteId = Number(sinfo.lastInsertRowid);
    const { PNG } = require('pngjs');
    const logoDir = path.join(process.env.EXPORT_ROOT, `ws-1-site-${siteId}`, 'images');
    fs.mkdirSync(logoDir, { recursive: true });
    const logoPng = new PNG({ width: 60, height: 20 });
    for (let i = 0; i < logoPng.data.length; i += 4) {
      logoPng.data[i] = 30;
      logoPng.data[i + 1] = 90;
      logoPng.data[i + 2] = 60;
      logoPng.data[i + 3] = 255;
    }
    fs.writeFileSync(path.join(logoDir, 'logo.png'), PNG.sync.write(logoPng));

    const card = await claimKit.buildBusinessCard(db, 1, { leadId, websiteId: siteId });
    assert.equal(card.filename, `bitpype-businesscard-maple-main-bakery-${leadId}.pdf`, 'card filename shape');
    n++;
    assert.deepEqual(card.addressLines, ['412 Maple Street', 'Reading, PA 19601'], 'address lines from the stored record');
    n++;
    assert.equal(card.hasLogo, true, 'stored PNG logo picked up');
    n++;
    assert.equal(card.siteUrl, SITE_URL, 'card QR target is the view-site URL');
    n++;
    assert.ok(Buffer.isBuffer(card.pdf) && card.pdf.slice(0, 5).toString() === '%PDF-', 'card is a PDF buffer');
    n++;
    const mb = card.pdf.toString('latin1').match(/\/MediaBox \[([^\]]+)\]/);
    assert.ok(mb && mb[1].trim() === '0 0 252 144', `card is exactly 3.5×2in (MediaBox ${mb && mb[1]})`);
    n++;
    assert.deepEqual(decodeAllQrsFromPdf(card.pdf), [SITE_URL], 'the card carries exactly ONE QR and it DECODES to the exact site URL');
    n++;
    const cardText = pdfPlainText(card.pdf);
    assert.ok(cardText.includes('Maple & Main Bakery'), 'card prints the business name');
    n++;
    assert.ok(cardText.includes('412 Maple Street'), 'card prints the stored street address');
    n++;
    assert.ok(cardText.includes('Reading, PA 19601'), 'card prints the city/state/zip line');
    n++;

    // No-address, text-mode-logo fixture: omission is graceful.
    const i2 = db
      .prepare(`INSERT INTO leads (business_name, email, status, category) VALUES (?, '', 'new', ?)`)
      .run('No Address Co', 'Plumbing');
    const lead2 = Number(i2.lastInsertRowid);
    db.prepare(`INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, ?, '{}', '[]', 'draft', ?)`)
      .run(lead2, 'No Address Co', SITE_URL + 'plain');
    const card2 = await claimKit.buildBusinessCard(db, 1, { leadId: lead2 });
    assert.deepEqual(card2.addressLines, [], 'no address on record → no address lines');
    n++;
    assert.equal(card2.hasLogo, false, 'text-mode logo → typeset name');
    n++;
    assert.equal(decodeQrFromPdf(card2.pdf), SITE_URL + 'plain', 'QR still decodes exactly without address/logo');
    n++;

    // Unembeddable logo file (SVG bytes wearing a .png name): no crash,
    // typeset fallback.
    const i3 = db
      .prepare(`INSERT INTO leads (business_name, email, status, address, city) VALUES (?, '', 'new', ?, ?)`)
      .run('Svg Logo Co', '9 Pine Rd', 'Fleetwood');
    const lead3 = Number(i3.lastInsertRowid);
    const s3 = db
      .prepare(`INSERT INTO websites (lead_id, name, theme, pages, status, preview_url) VALUES (?, ?, ?, '[]', 'draft', ?)`)
      .run(lead3, 'Svg Logo Co', JSON.stringify({ logoMode: 'image', logoUrl: 'images/logo.png' }), SITE_URL + 'svg');
    const site3 = Number(s3.lastInsertRowid);
    const dir3 = path.join(process.env.EXPORT_ROOT, `ws-1-site-${site3}`, 'images');
    fs.mkdirSync(dir3, { recursive: true });
    fs.writeFileSync(path.join(dir3, 'logo.png'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    const card3 = await claimKit.buildBusinessCard(db, 1, { leadId: lead3, websiteId: site3 });
    assert.equal(card3.hasLogo, false, 'SVG logo bytes are not embeddable → typeset fallback');
    n++;
    assert.deepEqual(card3.addressLines, ['9 Pine Rd', 'Fleetwood'], 'partial address still prints');
    n++;
    assert.equal(decodeQrFromPdf(card3.pdf), SITE_URL + 'svg', 'QR decodes with fallback logo');
    n++;

    // Mismatch + missing URL + unknown lead errors are coded.
    await assert.rejects(claimKit.buildBusinessCard(db, 1, { leadId, websiteId: site3 }), (e) => e.code === 'MISMATCH');
    n++;
    const i4 = db.prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, '', 'new')`).run('No Site Co');
    await assert.rejects(claimKit.buildBusinessCard(db, 1, { leadId: Number(i4.lastInsertRowid) }), (e) => e.code === 'NO_SITE_URL');
    n++;
    await assert.rejects(claimKit.buildBusinessCard(db, 1, { leadId: 999999 }), (e) => e.code === 'NOT_FOUND');
    n++;

    // Postcard regression on the same fixtures: untouched shape.
    const kit = await claimKit.buildClaimKit(db, 1, { leadId, includePdf: true });
    assert.equal(kit.filename, `bitpype-postcard-maple-main-bakery-${leadId}.pdf`, 'postcard filename unchanged');
    n++;
    const pmb = kit.pdf.toString('latin1').match(/\/MediaBox \[([^\]]+)\]/);
    assert.ok(pmb && pmb[1].trim() === '0 0 432 288', 'postcard still 6×4in');
    n++;
    const postcardQrs = decodeAllQrsFromPdf(kit.pdf);
    assert.ok(postcardQrs.includes(SITE_URL), 'postcard VIEW SITE QR still decodes to the site URL');
    n++;
    assert.ok(postcardQrs.some((u) => u.includes('/claim.html?t=')), 'postcard claim QR still present');
    n++;
    group('Part 2 card engine + QR proof + postcard regression', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
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
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      // Both routes refuse anonymous callers.
      for (const p of ['/api/v1/websites/1/business-card', '/api/v1/leads/1/business-card']) {
        const res = await fetch(`${BASE}${p}`, { headers: { 'x-forwarded-proto': 'https' } });
        assert.ok([401, 403].includes(res.status), `anonymous ${p} refused: ${res.status}`);
        n++;
      }

      // Staff sign-in (batch153 pattern incl. first-run MFA enrolment).
      const jar = makeJar();
      let res = await jar.fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD }),
      });
      let body = await json(res);
      assert.equal(res.status, 200, 'staff login: ' + JSON.stringify(body).slice(0, 200));
      n++;
      if (body.mfaRequired || (body.data && body.data.mfaRequired)) {
        const { totp } = require(path.join(root, 'src/totp.js'));
        res = await jar.fetch(`${BASE}/api/v1/auth/mfa/enroll/start`, { method: 'POST', body: '{}' });
        body = await json(res);
        const secret = body.data && body.data.secret;
        assert.ok(secret, 'enroll start returns a secret: ' + res.status + ' ' + JSON.stringify(body).slice(0, 300));
        res = await jar.fetch(`${BASE}/api/v1/auth/mfa/enroll/confirm`, {
          method: 'POST',
          body: JSON.stringify({ code: totp(secret) }),
        });
        body = await json(res);
        assert.equal(res.status, 200, 'enroll confirm: ' + JSON.stringify(body).slice(0, 200));
        n++;
      }

      // Fixture lead + generated site through the real APIs.
      res = await jar.fetch(`${BASE}/api/v1/leads`, {
        method: 'POST',
        body: JSON.stringify({
          business_name: 'Card Proof Bakery',
          email: 'cardproof-b157@example.invalid',
          address: '7 Card Way',
          city: 'Reading',
          state: 'PA',
          postal_code: '19601',
          category: 'Bakery',
        }),
      });
      body = await json(res);
      assert.ok([200, 201].includes(res.status), 'lead create: ' + res.status + ' ' + JSON.stringify(body).slice(0, 200));
      const leadId = body.data.lead ? body.data.lead.id : body.data.id;
      assert.ok(Number.isInteger(leadId) && leadId > 0, 'lead id issued');
      n++;
      res = await jar.fetch(`${BASE}/api/v1/websites/generate`, {
        method: 'POST',
        body: JSON.stringify({ leadId }),
        signal: AbortSignal.timeout(180000),
      });
      body = await json(res);
      assert.ok(res.status === 200 && body.data && body.data.id, 'site generated: ' + JSON.stringify(body).slice(0, 200));
      const siteId = body.data.id;
      n++;
      res = await jar.fetch(`${BASE}/api/v1/websites/${siteId}/preview`, {
        method: 'POST',
        body: JSON.stringify({ force: true }),
        signal: AbortSignal.timeout(180000),
      });
      body = await json(res);
      assert.equal(res.status, 200, 'preview export: ' + JSON.stringify(body).slice(0, 200));
      n++;
      res = await jar.fetch(`${BASE}/api/v1/websites/${siteId}/claim-kit`);
      body = await json(res);
      assert.equal(res.status, 200, 'claim kit JSON: ' + JSON.stringify(body).slice(0, 200));
      const siteUrl = body.data.siteUrl;
      assert.ok(siteUrl, 'claim kit reports a site URL');
      n++;

      // Card by website id.
      res = await jar.fetch(`${BASE}/api/v1/websites/${siteId}/business-card`);
      assert.equal(res.status, 200, 'website card download: ' + res.status);
      n++;
      assert.match(res.headers.get('content-type') || '', /application\/pdf/, 'website card is a PDF');
      n++;
      assert.match(res.headers.get('content-disposition') || '', /bitpype-businesscard-card-proof-bakery-\d+\.pdf/, 'website card filename');
      n++;
      const pdfA = Buffer.from(await res.arrayBuffer());
      assert.equal(decodeQrFromPdf(pdfA), siteUrl, 'served card QR decodes to the claim-kit site URL');
      n++;
      assert.ok(pdfPlainText(pdfA).includes('7 Card Way'), 'served card prints the stored address');
      n++;

      // Card by lead id — same QR target.
      res = await jar.fetch(`${BASE}/api/v1/leads/${leadId}/business-card`);
      assert.equal(res.status, 200, 'lead card download: ' + res.status);
      n++;
      const pdfB = Buffer.from(await res.arrayBuffer());
      assert.equal(decodeQrFromPdf(pdfB), siteUrl, 'lead-route card QR decodes to the same site URL');
      n++;

      // Unknown website: coded error, never a PDF.
      res = await jar.fetch(`${BASE}/api/v1/websites/424242/business-card`);
      assert.ok(res.status >= 400, 'unknown website card refused: ' + res.status);
      n++;
      assert.doesNotMatch(res.headers.get('content-type') || '', /application\/pdf/, 'unknown website does not return a PDF');
      n++;
      group('Part 3 HTTP routes', n);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }

  console.log(`\nbatch157 business card: PASS — ${groups.length} groups`);
})().catch((e) => {
  console.error('batch157 business card: FAIL');
  console.error(e);
  process.exit(1);
});
