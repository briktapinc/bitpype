'use strict';
/**
 * Batch 141 — DETAIL PAGE POLISH (Ely chain order, 2026-11-05:
 * Batch 133's detail shells "still lack header/footer and photo —
 * that polish is Batch 141").
 *
 * What Batch 133 shipped: one universal detail shell (item.html) +
 * a real copy per published item at detail/<type>/<key>.html,
 * resolving the item live through the public API. The shell carried
 * site chrome ONLY when the theme used partials — sites whose chrome
 * is nav/footer SECTIONS (the common case) got a bare shell: no
 * header, no footer, and Batch 142's nav cart had no nav to land in.
 * The item's photo likewise never appeared in the shell itself.
 *
 * What this pins:
 *   Part 1 — source pins: the shared chrome assembly
 *     (computeNavLinks extracted from renderPage; siteChromeHtml)
 *     feeds buildDetailPage AND build404Page; the per-item photo
 *     bake (opts.detailItemImage) and detailExportContext's photo
 *     resolution (detailItemPhoto, ctx.photos); MODULE_TYPES stays
 *     29 and MODULE_SCRIPT_VER stays mod39 (module-embed.js is NOT
 *     touched — the cart is Batch 142's runtime, reused as-is).
 *   Part 2 — in-process: detailExportContext resolves per-item
 *     primary photos (product image_url, blog cover_image; a
 *     photo-less item gets none; the empty context keeps its exact
 *     { types } shape); a fixture export's per-item shells carry the
 *     site's nav + footer (href-for-href the same chrome renderPage
 *     puts on the home page), the photo item's shell carries its
 *     photo as the root's initial .bp-mod-hero, the photo-less
 *     item's shell carries no <img> at all, the generic item.html
 *     carries chrome but no photo, and 404.html carries the chrome.
 *   Part 3 — the REAL preview server serves an unknown detail slug
 *     as a TRUE 404 whose body is the chromed 404.html, and a known
 *     slug as its 200 shell.
 *   Part 4 — real Chromium against a fixture server serving the
 *     REAL exported shells + the REAL module-embed.js + REAL
 *     payloads captured in-process: on a checkout site the detail
 *     page gets exactly ONE [data-bp-nav-cart], inside the nav
 *     section, reading its count/total from the SAME cart storage
 *     as every other page; on a no-checkout site it gets none; the
 *     rendered detail shows the item + its hero photo; the Batch
 *     135 spacing floor (section-pad + overflow, measured with
 *     spacingQa's own in-page measure) passes on the detail page
 *     at 390 / 980 / 1440.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch141-'));
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.SESSION_SECRET = ['b141', 'regression', 'session', 'secret', 'for', 'tests'].join('-');
process.env.COOKIE_SECURE = 'false';
// Standard suite header (Batch 127 lesson): the real-server boot
// refuses production mode without these two lines.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';
// Part 3 drives the real preview server on its own port + root.
process.env.WS_PREVIEW_PORT = '18741';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');

const root = path.resolve(__dirname, '..');
const LEAD_A = 14101; // checkout site
const LEAD_B = 14102; // no-checkout site
const MONSTERA_IMG = 'https://img141.example/monstera.jpg';
const COVER_IMG = 'https://img141.example/watering-cover.jpg';

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
const hrefs = (html) => [...String(html).matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]);

function fixturePages() {
  return [
    {
      slug: '/',
      title: 'Home',
      sections: [
        { type: 'nav', content: { business_name: 'B141 Plants' } },
        { type: 'heading', content: { title: 'B141 Plants' } },
        { type: 'footer', content: { business_name: 'B141 Plants', tagline: 'Plants for everyone.' } },
      ],
    },
    { slug: 'shop', title: 'Shop', sections: [{ type: 'heading', content: { title: 'Shop' } }] },
    { slug: 'about', title: 'About', sections: [{ type: 'heading', content: { title: 'About' } }] },
    { slug: 'checkout', title: 'Checkout', sections: [{ type: 'heading', content: { title: 'Checkout' } }] },
  ];
}

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const engineSrc = read('src/websiteEngine.js');
    assert.ok(engineSrc.includes('function computeNavLinks(pages, preview)'), 'nav-link computation extracted');
    n++;
    assert.ok(engineSrc.includes('const navLinks = computeNavLinks(pages, preview);'), 'renderPage uses the shared computation');
    n++;
    assert.ok(engineSrc.includes('function siteChromeHtml(pages, theme)'), 'shared chrome assembly exists');
    n++;
    assert.ok(
      (engineSrc.match(/siteChromeHtml\(pages, t\)/g) || []).length >= 2,
      'detail shell AND 404 page both build through siteChromeHtml'
    );
    n++;
    assert.ok(engineSrc.includes('opts.detailItemImage'), 'detail shell accepts the per-item photo');
    n++;
    assert.ok(engineSrc.includes('<img class="bp-mod-hero"'), 'the bake uses the renderItem hero treatment');
    n++;
    assert.ok(engineSrc.includes('seo.detail.photos'), 'writeStaticPages reads the resolved photos');
    n++;
    assert.ok(!engineSrc.includes('data-bp-nav-cart'), 'the exporter does NOT stamp a cart — Batch 142 runtime owns it');
    n++;

    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes('function detailItemPhoto(type, it)'), 'photo resolution exists in siteModules');
    n++;
    assert.ok(smSrc.includes('out.photos = photos'), 'detail context attaches photos');
    n++;
    assert.ok(smSrc.includes("const MODULE_SCRIPT_VER = 'mod41'"), 'MODULE_SCRIPT_VER unchanged (mod39) — no embed change');
    n++;
    const typesBlock = /const MODULE_TYPES = \[([\s\S]*?)\];/.exec(smSrc);
    assert.equal((typesBlock[1].match(/'/g) || []).length / 2, 32, 'MODULE_TYPES counted (Batch 141: stayed 29 at its tip — polish adds no module type; Batch 164: custom_code is the 30th; Batch 165: webinar is the 31st; Batch 178 finisher rotation: leads_router is the 32nd)');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('registerNavCartFromPayload(data)'), 'detail boot still registers the nav cart from the payload (142 reuse)');
    n++;
    group('Part 1 source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — in-process: context photos + fixture export                */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a141@example.invalid',
    password: ['B141', 'Workspace', 'Pass'].join('-') + '!',
    name: 'A141',
    workspaceName: 'Batch141 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B141 Plant Shop', 'plants141@example.invalid'],
    [LEAD_B, 'B141 Plain Shop', 'plain141@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(id, name, email, 'customer');
  }

  let shopTokenA = '';
  let shopTokenB = '';
  let checkoutTokenA = '';
  let monsteraKey = '';
  let fernKey = '';
  let fernBKey = '';
  let postKey = '';
  let ctxA;
  {
    let n = 0;
    sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    sm.attachModule(db, LEAD_A, 'checkout', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    sm.attachModule(db, LEAD_A, 'blog', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    sm.attachModule(db, LEAD_B, 'ecommerce', { workspaceId: WS_ID, appUrl: 'https://example.test' });
    shopTokenA = sm.getEmbedRow(db, LEAD_A, 'ecommerce').public_token;
    shopTokenB = sm.getEmbedRow(db, LEAD_B, 'ecommerce').public_token;
    checkoutTokenA = sm.getEmbedRow(db, LEAD_A, 'checkout').public_token;
    assert.ok(shopTokenA && shopTokenB && checkoutTokenA, 'fixture embeds carry public tokens');
    n++;

    const monstera = sm.createProduct(db, LEAD_A, {
      name: 'Monstera Deliciosa',
      price: 58,
      status: 'published',
      image_url: MONSTERA_IMG,
    });
    const fern = sm.createProduct(db, LEAD_A, { name: 'Plain Fern', price: 12, status: 'published' });
    const fernB = sm.createProduct(db, LEAD_B, { name: 'Plain Fern', price: 12, status: 'published' });
    const post = sm.createBlogPost(db, LEAD_A, {
      title: 'Watering Your Monstera',
      body_html: '<p>Water weekly.</p>',
      status: 'published',
      cover_image: COVER_IMG,
    });
    monsteraKey = monstera.slug || String(monstera.id);
    fernKey = fern.slug || String(fern.id);
    fernBKey = fernB.slug || String(fernB.id);
    postKey = post.slug || String(post.id);
    assert.ok(monsteraKey && fernKey && postKey, 'fixture items carry keys');
    n++;

    ctxA = sm.detailExportContext(db, LEAD_A);
    assert.equal(ctxA.photos.ecommerce[monsteraKey], MONSTERA_IMG, 'product primary photo resolved from image_url');
    n++;
    assert.ok(!(fernKey in (ctxA.photos.ecommerce || {})), 'photo-less product resolves NO photo');
    n++;
    assert.equal(ctxA.photos.blog[postKey], COVER_IMG, 'blog primary photo resolved from cover_image');
    n++;
    assert.deepEqual(sm.detailExportContext(db, LEAD_B).photos, undefined, 'a photo-less site context carries no photos key');
    n++;
    assert.deepEqual(
      sm.detailExportContext(db, 141099),
      { types: {} },
      'an item-less lead keeps the exact { types } context shape (Batch 133 pin)'
    );
    n++;
    // The no-checkout lead's product still resolves its detail payload.
    const itemB = sm.getPublicModuleItem(db, shopTokenB, fernB.slug || String(fernB.id));
    assert.ok(itemB.item && !itemB.site_checkout && !itemB.checkout_token, 'no-checkout payload carries no cart signal');
    n++;
    const itemA = sm.getPublicModuleItem(db, shopTokenA, monsteraKey);
    assert.equal(itemA.site_checkout && itemA.site_checkout.token, checkoutTokenA, 'checkout payload carries the sitewide stamp');
    n++;
    group('Part 2 context photos', n);
  }

  /* ---- fixture export: shells carry chrome + photos ---- */
  let outDirA = '';
  {
    let n = 0;
    const pages = fixturePages();
    const detailA = sm.detailExportContext(db, LEAD_A);
    outDirA = path.join(os.tmpdir(), `b141-site-a-${Date.now()}`);
    engine.writeStaticPages(pages, {}, outDirA, {
      seo: { baseUrl: 'https://plants141.example', moduleFaqItems: [], gscToken: '', blog: null, detail: detailA },
      siteUpdatedAt: '2026-11-06T00:00:00Z',
    });
    const rd = (rel) => fs.readFileSync(path.join(outDirA, rel), 'utf8');
    const exists = (rel) => fs.existsSync(path.join(outDirA, rel));
    assert.ok(exists('detail/ecommerce/' + monsteraKey + '.html'), 'photo item shell exported');
    n++;
    assert.ok(exists('detail/ecommerce/' + fernKey + '.html'), 'photo-less item shell exported');
    n++;
    assert.ok(exists('detail/blog/' + postKey + '.html'), 'blog item shell exported');
    n++;

    const homeHtml = engine.renderPage(pages[0], pages, {}, {});
    const homeHrefs = hrefs(homeHtml);
    assert.ok(homeHrefs.includes('/shop') && homeHrefs.includes('/about'), 'home fixture chrome links the site pages');
    n++;

    const monsteraShell = rd('detail/ecommerce/' + monsteraKey + '.html');
    assert.ok(monsteraShell.includes('data-ws-section-type="nav"'), 'detail shell carries the site nav section');
    n++;
    assert.ok(monsteraShell.includes('data-ws-section-type="footer"'), 'detail shell carries the site footer section');
    n++;
    assert.deepEqual(
      hrefs(monsteraShell),
      homeHrefs,
      'detail chrome hrefs match the home page chrome href-for-href (same nav links, same footer)'
    );
    n++;
    assert.ok(
      monsteraShell.includes(`<img class="bp-mod-hero" src="${MONSTERA_IMG}"`),
      "photo item's shell bakes its primary photo as the detail hero"
    );
    n++;
    assert.equal(
      (monsteraShell.match(/bp-mod-hero/g) || []).length,
      1,
      'exactly one baked hero in the shell (renderItem replaces it live at view time)'
    );
    n++;

    const fernShell = rd('detail/ecommerce/' + fernKey + '.html');
    assert.ok(fernShell.includes('data-ws-section-type="nav"'), 'photo-less shell still chromed');
    n++;
    assert.ok(!fernShell.includes('<img'), 'photo-less item shell carries NO <img> at all (no broken img, no placeholder)');
    n++;
    assert.ok(!fernShell.includes('bp-mod-hero'), 'photo-less shell carries no hero markup');
    n++;

    const postShell = rd('detail/blog/' + postKey + '.html');
    assert.ok(postShell.includes(`<img class="bp-mod-hero" src="${COVER_IMG}"`), 'blog shell bakes its cover photo');
    n++;

    const genericShell = rd('item.html');
    assert.ok(genericShell.includes('data-ws-section-type="nav"'), 'generic item.html carries the chrome too');
    n++;
    assert.ok(!genericShell.includes('bp-mod-hero'), 'generic item.html carries no photo');
    n++;

    const nf = rd('404.html');
    assert.ok(nf.includes('data-ws-section-type="nav"'), 'exported 404.html carries the nav');
    n++;
    assert.ok(nf.includes('data-ws-section-type="footer"'), 'exported 404.html carries the footer');
    n++;
    assert.ok(nf.includes('Page not found'), 'exported 404.html keeps its not-found body');
    n++;

    // Partials themes keep precedence over sections (same rule as
    // regular pages): partial chrome renders, section chrome does not.
    const partialShell = engine.buildDetailPage(
      pages,
      { partials: { headerHtml: '<header class="b141-hdr">H</header>', footerHtml: '<footer class="b141-ftr">F</footer>' } },
      { seo: { detail: detailA } }
    );
    assert.ok(partialShell.includes('b141-hdr') && partialShell.includes('b141-ftr'), 'partials chrome wins on the shell');
    n++;
    assert.ok(!partialShell.includes('data-ws-section-type="nav"'), 'partials suppress the section nav on the shell');
    n++;

    // A page that overrides chrome suppresses it on shells too.
    const overridePages = [
      {
        slug: '/',
        title: 'Home',
        chromeOverride: true,
        sections: [
          { type: 'nav', content: { business_name: 'B141 Plants' } },
          { type: 'footer', content: { business_name: 'B141 Plants' } },
        ],
      },
    ];
    const bareChrome = engine.siteChromeHtml(overridePages, {});
    assert.deepEqual(bareChrome, { header: '', footer: '' }, 'chromeOverride home yields empty chrome');
    n++;
    group('Part 2 fixture export', n);
  }

  /* ================================================================== */
  /* Part 3 — the real preview server: unknown slug = chromed TRUE 404   */
  /* ================================================================== */
  {
    let n = 0;
    const exportRootDir = process.env.EXPORT_ROOT;
    fs.mkdirSync(exportRootDir, { recursive: true });
    fs.cpSync(outDirA, path.join(exportRootDir, 'site141'), { recursive: true });
    const preview = require(path.join(root, 'src/previewServer.js'));
    await preview.ensureListening();
    const base = preview.baseUrl() + '/site141';
    assert.ok(preview.baseUrl(), 'preview server is listening');
    n++;
    const get = (url) =>
      new Promise((resolve, reject) => {
        http
          .get(url, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          })
          .on('error', reject);
      });

    const missing = await get(`${base}/detail/ecommerce/definitely-not-here`);
    assert.equal(missing.status, 404, 'unknown detail slug is a REAL 404 (not a soft-200)');
    n++;
    assert.ok(missing.body.includes('data-ws-section-type="nav"'), 'the 404 body carries the site nav');
    n++;
    assert.ok(missing.body.includes('data-ws-section-type="footer"'), 'the 404 body carries the site footer');
    n++;
    assert.ok(missing.body.includes('Page not found'), 'the 404 body is the site not-found page');
    n++;

    const known = await get(`${base}/detail/ecommerce/${monsteraKey}`);
    assert.equal(known.status, 200, 'known detail slug serves its shell');
    n++;
    assert.ok(known.body.includes(`src="${MONSTERA_IMG}"`), 'the served shell carries the item photo');
    n++;
    await preview.stop();
    group('Part 3 preview-server 404', n);
  }

  /* ================================================================== */
  /* Part 4 — Chromium: cart lands in the shell nav; spacing floor holds */
  /* ================================================================== */
  {
    let n = 0;
    const puppeteer = require('puppeteer');
    async function launchBrowser() {
      const opts = {
        headless: true,
        protocolTimeout: 180000,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      };
      const candidates = [];
      try {
        candidates.push(puppeteer.executablePath());
      } catch {
        /* fall through */
      }
      const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
      try {
        for (const v of fs.readdirSync(cacheDir).sort().reverse()) {
          candidates.push(path.join(cacheDir, v, 'chrome-linux64', 'chrome'));
        }
      } catch {
        /* ignore */
      }
      for (const c of candidates) {
        if (c && fs.existsSync(c)) {
          opts.executablePath = c;
          break;
        }
      }
      return puppeteer.launch(opts);
    }

    // One fixture origin PER SITE: the shells bake their origin as
    // the API base, and detail pages must be served at the canonical
    // /detail/<type>/<slug> path (module-embed resolves type+slug
    // from the path), so the two sites cannot share a path prefix.
    function makeFixture() {
      const fx = { dir: '', payloads: new Map(), server: null, origin: '' };
      fx.server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, 'http://fixture.invalid');
          if (process.env.B141_DEBUG) console.log('  [fixture]', req.method, url.pathname + url.search);
          if (url.pathname === '/js/module-embed.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            res.end(fs.readFileSync(path.join(root, 'public/js/module-embed.js')));
            return;
          }
          if (url.pathname.startsWith('/api/v1/modules/public/')) {
            const token = decodeURIComponent(url.pathname.slice('/api/v1/modules/public/'.length));
            const slug = url.searchParams.get('slug') || '';
            const payload = fx.payloads.get(token + '|' + slug);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload ? { ok: true, data: payload } : { ok: false, error: 'unknown token' }));
            return;
          }
          if (url.pathname.startsWith('/detail/')) {
            const file = path.join(fx.dir, url.pathname.replace(/^\/+/, '') + '.html');
            if (fx.dir && fs.existsSync(file)) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(fs.readFileSync(file));
              return;
            }
          }
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('fixture 404');
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(String((e && e.message) || e));
        }
      });
      return fx;
    }
    const fxA = makeFixture();
    const fxB = makeFixture();
    await new Promise((resolve) => fxA.server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => fxB.server.listen(0, '127.0.0.1', resolve));
    fxA.origin = `http://127.0.0.1:${fxA.server.address().port}`;
    fxB.origin = `http://127.0.0.1:${fxB.server.address().port}`;
    const prevAppUrl = process.env.APP_URL;
    let browser;
    try {
      const pages = fixturePages();
      process.env.APP_URL = fxA.origin;
      fxA.dir = path.join(os.tmpdir(), `b141-site-a4-${Date.now()}`);
      engine.writeStaticPages(pages, {}, fxA.dir, {
        seo: { baseUrl: fxA.origin, moduleFaqItems: [], gscToken: '', blog: null, detail: sm.detailExportContext(db, LEAD_A) },
        siteUpdatedAt: '2026-11-06T00:00:00Z',
      });
      process.env.APP_URL = fxB.origin;
      fxB.dir = path.join(os.tmpdir(), `b141-site-b4-${Date.now()}`);
      engine.writeStaticPages(pages, {}, fxB.dir, {
        seo: { baseUrl: fxB.origin, moduleFaqItems: [], gscToken: '', blog: null, detail: sm.detailExportContext(db, LEAD_B) },
        siteUpdatedAt: '2026-11-06T00:00:00Z',
      });
      const itemPayloadA = sm.getPublicModuleItem(db, shopTokenA, monsteraKey);
      const itemPayloadB = sm.getPublicModuleItem(db, shopTokenB, fernBKey);
      fxA.payloads.set(shopTokenA + '|' + monsteraKey, itemPayloadA);
      fxB.payloads.set(shopTokenB + '|' + fernBKey, itemPayloadB);
      assert.ok(itemPayloadA.site_checkout && itemPayloadB.item, 'browser payloads captured');
      n++;

      browser = await launchBrowser();
      const pageErrors = [];
      const wire = (page) => page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

      /* checkout site: one cart in the nav, reading the shared cart store */
      const pageA = await browser.newPage();
      wire(pageA);
      await pageA.evaluateOnNewDocument(
        (key, lines) => {
          try {
            window.localStorage.setItem(key, JSON.stringify(lines));
          } catch (e) {
            /* storage unavailable */
          }
        },
        'bp-cart-' + checkoutTokenA,
        [
          {
            source: 'ecommerce',
            itemId: monsteraKey,
            variantId: null,
            variantLabel: '',
            name: 'Monstera Deliciosa',
            image_url: MONSTERA_IMG,
            price_cents: 5800,
            currency: 'USD',
            qty: 1,
          },
        ]
      );
      await pageA.goto(`${fxA.origin}/detail/ecommerce/${monsteraKey}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pageA.waitForFunction(
        () => {
          const h1 = document.querySelector('.bp-mod-detail h1');
          return h1 && h1.textContent.includes('Monstera Deliciosa');
        },
        { timeout: 15000 }
      );
      const cartInfo = await pageA.evaluate(() => {
        const carts = [...document.querySelectorAll('[data-bp-nav-cart]')];
        const cart = carts[0] || null;
        return {
          count: carts.length,
          inNav: !!(cart && cart.closest('[data-ws-section-type="nav"]')),
          href: cart ? cart.getAttribute('href') : null,
          summary: cart ? (cart.querySelector('[data-bp-nav-cart-summary]') || {}).textContent || '' : '',
        };
      });
      assert.equal(cartInfo.count, 1, 'checkout detail page carries EXACTLY ONE nav cart');
      n++;
      assert.ok(cartInfo.inNav, 'the cart lives inside the shell nav section');
      n++;
      assert.equal(cartInfo.href, itemPayloadA.site_checkout.page, 'cart href is the payload checkout page (142 stamp, unforked)');
      n++;
      assert.ok(
        cartInfo.summary.includes('1 item') && cartInfo.summary.includes('$58.00'),
        `cart reads the SHARED cart store (summary: "${cartInfo.summary}")`
      );
      n++;
      const rendered = await pageA.evaluate(() => {
        const hero = document.querySelector('.bp-mod-detail img.bp-mod-hero');
        return { heroSrc: hero ? hero.getAttribute('src') : null };
      });
      assert.equal(rendered.heroSrc, MONSTERA_IMG, 'live render keeps the item hero photo');
      n++;

      /* spacing floor on the detail page (Batch 135 measure, in-page) */
      const spacingQa = require(path.join(root, 'server/spacingQa.js'));
      const floors = spacingQa.spacingTokens();
      for (const width of [390, 980, 1440]) {
        await pageA.setViewport({ width, height: width <= 700 ? 844 : 960, deviceScaleFactor: 1 });
        await new Promise((r) => setTimeout(r, 120));
        const report = await pageA.evaluate(spacingQa.measureSpacingInPage, floors);
        const bad = report.violations.filter((v) => v.kind === 'section-pad' || v.kind === 'overflow');
        assert.deepEqual(bad, [], `spacing floor holds on the detail page @${width} (no section-pad / overflow violations)`);
        n++;
      }
      await pageA.close();

      /* no-checkout site: chromed + rendered, and NO cart */
      const pageB = await browser.newPage();
      wire(pageB);
      await pageB.goto(`${fxB.origin}/detail/ecommerce/${fernBKey}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pageB.waitForFunction(
        () => {
          const h1 = document.querySelector('.bp-mod-detail h1');
          return h1 && h1.textContent.includes('Plain Fern');
        },
        { timeout: 15000 }
      );
      const bInfo = await pageB.evaluate(() => ({
        carts: document.querySelectorAll('[data-bp-nav-cart]').length,
        nav: !!document.querySelector('[data-ws-section-type="nav"]'),
        hero: document.querySelectorAll('.bp-mod-detail img.bp-mod-hero').length,
      }));
      assert.equal(bInfo.carts, 0, 'non-checkout detail page carries NO nav cart');
      n++;
      assert.ok(bInfo.nav, 'non-checkout detail page still carries the site chrome');
      n++;
      assert.equal(bInfo.hero, 0, 'photo-less item renders with no hero image');
      n++;
      await pageB.close();

      assert.deepEqual(pageErrors, [], 'no page errors across detail pages');
      n++;
      group('Part 4 browser end-to-end', n);
    } finally {
      process.env.APP_URL = prevAppUrl;
      if (browser) await browser.close().catch(() => {});
      await new Promise((resolve) => fxA.server.close(resolve));
      await new Promise((resolve) => fxB.server.close(resolve));
    }
  }

  console.log(`\nBatch 141 detail polish: ALL PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH141 FAIL:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
