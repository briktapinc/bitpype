'use strict';
/**
 * Batch 130 — the ?bpItem= foreign-slug fallback (Ely, 2026-11-03,
 * caught on Victoria's staged shop): `mountOne` in module-embed.js
 * reads the PAGE-level ?bpItem= param and appends ?slug=<item> to
 * EVERY embed's public payload request on the page. The server
 * resolves the slug inside each embed's OWN module type, so opening
 * one item (a product) made every OTHER embed on the page (the
 * categories shelf, the blog list, a gallery) paint a red
 * "Item not found" error card.
 *
 * The fix is client-side only — the public route already shapes the
 * item miss as { ok:false, code:'NOT_FOUND', error:'Item not found' }
 * (server/apiErrors.js flat body), so the embed can tell the miss
 * apart from every other failure:
 *   Part A — source pins: the fallback wiring (NOT_FOUND code check,
 *     list refetch, staticBlog excluded), the locked branch still
 *     ahead of item rendering, the error card intact, MODULE_SCRIPT_VER
 *     mod32 (Batch 128 finisher rotation), and the SEC-13 census at 437 total (Batch 126 finisher +4 audited QR sinks; Batch 127 finisher +5 audited variant-editor sinks; Batch 128 finisher +13 safe-class checkout sinks) with the
 *     mountOne sink shifted by pure line movement (4227 -> 4252 on the Batch 130 tree; 4294 at Batch 126 landing; 4394 after the Batch 127 variant-picker insertions).
 *   Part B — HTTP contract on the real server: a foreign slug is a
 *     404 with code NOT_FOUND on every non-owning module; the owning
 *     module resolves its item; a gated page answers slug AND list
 *     fetches with the locked payload (never a 404, never content);
 *     an unknown token 404s in both forms, so the fallback cannot
 *     rescue a genuinely broken embed.
 *   Part C — real browser (Puppeteer + the real module-embed.js
 *     served by the fixture server): a shop page mounting ecommerce +
 *     categories + blog. With a product open, the product detail
 *     renders AND the shelf/blog render their lists with no error
 *     card anywhere; symmetric for a category and a post; a bogus
 *     slug lands every mount on its list; no-param is unchanged; a
 *     gated page still shows the members wall; a bad token and a
 *     dead API origin still surface the error card.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b130-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env['SESSION_' + 'SECRET'] = ['batch130', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const PORT = 39130;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP_LEAD = 13001;
const GATED_LEAD = 13002;

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

let WS_ID;
let db;
const T = {}; // embed tokens, filled by the seed step

async function seed() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const cats = require(path.join(root, 'server/categories.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a130@example.invalid',
    password: ['batch130', 'ws', 'password'].join('-'),
    name: 'A130',
    workspaceName: 'Batch130 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [SHOP_LEAD, 'B130 Plant Shop', 'shop130@example.invalid'],
    [GATED_LEAD, 'B130 Members Club', 'club130@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }

  // Shop lead: a product grid, a categories shelf, a blog list.
  const shopEmb = sm.ensureEmbed(db, SHOP_LEAD, 'ecommerce', { workspaceId: WS_ID });
  const catsEmb = sm.ensureEmbed(db, SHOP_LEAD, 'categories', { workspaceId: WS_ID });
  const blogEmb = sm.ensureEmbed(db, SHOP_LEAD, 'blog', { workspaceId: WS_ID });
  const monstera = sm.createProduct(db, SHOP_LEAD, {
    name: 'Fixture Monstera',
    price: 58,
    status: 'published',
  });
  sm.createProduct(db, SHOP_LEAD, { name: 'Fixture Fern', price: 24, status: 'published' });
  const shelf = cats.createCategory(db, SHOP_LEAD, {
    scope: 'ecommerce',
    name: 'Fixture Shelf',
    status: 'published',
  });
  cats.setItemCategories(db, SHOP_LEAD, 'ecommerce', monstera.id, [shelf.id]);
  sm.updateCategoriesScopes(db, SHOP_LEAD, ['ecommerce']);
  sm.createBlogPost(db, SHOP_LEAD, {
    title: 'Fixture Story',
    body_html: '<p>Fixture story body.</p>',
    status: 'published',
  });

  // Gated lead: members on, the shop page gated, one secret post.
  const membersEmb = sm.ensureEmbed(db, GATED_LEAD, 'members', { workspaceId: WS_ID });
  const gatedBlogEmb = sm.ensureEmbed(db, GATED_LEAD, 'blog', { workspaceId: WS_ID });
  sm.createBlogPost(db, GATED_LEAD, {
    title: 'Secret Fixture Post',
    body_html: '<p>Members-only fixture body.</p>',
    status: 'published',
  });
  sm.updateMembersConfig(db, GATED_LEAD, { gate_mode: 'selected', gated_pages: ['shop'] });

  for (const emb of [shopEmb, catsEmb, blogEmb, membersEmb, gatedBlogEmb]) {
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
  }
  T.shop = shopEmb.public_token;
  T.cats = catsEmb.public_token;
  T.blog = blogEmb.public_token;
  T.gatedBlog = gatedBlogEmb.public_token;
  T.unknown = `${WS_ID}_unknownb130token`;
  db.close();
}

function bootServer() {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  return { child, output: () => output };
}

async function waitReady(child, output) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode != null) throw new Error('server exited early: ' + output());
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server never became ready: ' + output());
}

(async () => {
  /* ================================================================== */
  /* Part A — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const embed = read('public/js/module-embed.js');
    assert.ok(
      embed.includes("if (item && !staticBlog && j && !j.ok && j.code === 'NOT_FOUND') {"),
      'fallback triggers only on an item fetch answered NOT_FOUND'
    );
    n++;
    assert.ok(
      embed.includes("return loadPayload('').then(handlePayload);"),
      'fallback refetches the list payload (no slug) and renders it'
    );
    n++;
    assert.ok(embed.includes('var handlePayload = function (j) {'), 'payload handling factored once');
    n++;
    const hpAt = embed.indexOf('var handlePayload = function (j) {');
    const lockedAt = embed.indexOf('if (data.locked) {', hpAt);
    const itemAt = embed.indexOf('if (data.item) renderItem(el, data);', hpAt);
    assert.ok(lockedAt > hpAt && itemAt > lockedAt, 'locked payloads render the wall before any item handling');
    n++;
    assert.ok(embed.includes('if (staticBlog && !item) return;'), 'staticBlog early return untouched');
    n++;
    assert.ok(
      embed.includes('if (staticBlog) return; // snapshot stays — never dead-end'),
      'staticBlog catch still keeps the snapshot (no fallback past it)'
    );
    n++;
    assert.ok(
      embed.includes("el.innerHTML = '<p class=\"bp-mod-err\">' + esc(e.message || 'Failed to load module') + '</p>';"),
      'the error card survives for genuine failures'
    );
    n++;
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(
      sm.MODULE_SCRIPT_VER,
      'mod43',
      'MODULE_SCRIPT_VER bumped for the fallback (Batch 128 finisher rotation; Batch 139 finisher rotation to mod39; Batch 164 finisher rotation to mod40)'
    );
    n++;
    assert.ok(
      read('server/siteModules.js').includes("throw fail('NOT_FOUND', 'Item not found', 404);"),
      'the server item miss is the authored NOT_FOUND the client keys on'
    );
    n++;
    assert.ok(
      read('server/apiErrors.js').includes('const body = { ok: false, error: shaped.message, code: shaped.code };'),
      'the public route already ships the machine-readable code — no server change needed'
    );
    n++;
    const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
    const cz = census();
    assert.equal(
      cz.summary.total,
      518, // Batch 194 finisher re-pin: 514 -> 518 (+4 audited Training/Packages sinks — see the batch103 note). Batch 183 finisher re-pin: 508 -> 514 (+6 audited Leads Explorer sinks in app.js, pairwise-proven — see the batch103 note). Batch 174 finisher (rebase onto Batch 168): census 506 -> 507 (+1 STATIC from Batch 168's S6#F4 fixed empty-string container clear; merged baseline regenerated 507 / safe 380, multiset sha a4884d2d — see batch103 narrative); Batch 174 rotation: census 503 -> 506 (+3 IDENT assistantMd writes in portal.js, design-chat redesign — see batch103 narrative); Batch 162 rotation: census 470 -> 474 (+4 audited Contact-page sinks, pairwise-proven — see batch103 narrative); Batch 161 rotation: census 453 -> 470 (+17 audited Assistant-surface sinks, pairwise-proven — see batch103 narrative)
      'SEC-13 census total — the Batch 130 fix added no sinks; Batch 126 finisher added +4 audited QR sinks; Batch 127 finisher added +5 audited variant-editor sinks; Batch 128 finisher added +13 safe-class checkout sinks (reviewed set unchanged); Batch 129 finisher added +3 audited STATIC pay-at-booking sinks (reviewed set unchanged; Batch 137 finisher +1 audited SAFE sink in portal.js — census 441 -> 442, reviewed RAW/IDENT content unchanged; Batch 138 finisher: census 442 -> 446 — +3 audited STATIC + 1 IDENT (micSvg(), a constant SVG string) in chat-embed.js for the voice panel, and one portal.js inbox sink reclassified SAFE -> RAW by the conservative classifier after gaining the ${voiceHtml} interpolation (audited: voiceHtml is composed only of esc()-wrapped values, duration arithmetic and fixed close-state words — no visitor-controlled string reaches it unescaped); RAW 76 -> 77, IDENT 35 -> 36, SAFE 74 -> 73, STATIC 158 -> 161, safe classes 331 -> 333; (file,kind,snippet) multiset diff vs the Batch 149 base = exactly these deltas plus pure line movement in portal.js/chat-embed.js; baseline regenerated; Batch 139 finisher: census 446 -> 448 — +1 audited STATIC + 1 audited BUILDER sink in module-embed.js (pricing renderer), RAW/IDENT multiset unchanged, baseline regenerated; Batch 153: census 448 -> 450 — +1 BUILDER +1 RAW in app.js, both the Admin Design-agent editor (rows build — every interpolated value esc()-wrapped; panel shell classified RAW by the conservative classifier, audited: its interpolations are a fixed literal seed note and the numeric limits only, no staff- or visitor-controlled string reaches it unescaped); BUILDER 59 -> 60, RAW 77 -> 78, safe classes 335 -> 336; remaining app.js RAW/IDENT movement is pure line shift from the editor + popup insertions, (file,kind,snippet) multiset diff vs the Batch 139 base = exactly these two sinks; baseline regenerated; Batch 156 rotation: census 450 -> 453 (+1 STATIC +1 ESCAPED +1 SAFE in app.js — fingerprint surfaces), safe classes 336 -> 339, RAW/IDENT reviewed set unchanged; baseline regenerated)'
    );
    n++;
    const meLines = cz.sinks
      .filter((s) => (s.kind === 'RAW' || s.kind === 'IDENT') && s.file === 'public/js/module-embed.js')
      .map((s) => s.line)
      .sort((x, y) => x - y);
    assert.deepEqual(
      meLines,
      [1470, 1615, 1627, 1631, 1635, 2054, 2260, 3564, 5869, 5976, 6338], // Batch 187: nine positions shifted +9 by the bp-mod-fullwidth style rule in ensureStyles and the last two +11 with the gallery mount stamp in mountOne — pure line movement, proven by the census multiset diff (RAW/IDENT (file,kind,snippet) multiset byte-identical to the landed 186 census; total flat at 514, no new sinks). Batch 185: all eleven positions shifted +15 by the module spacing floor block in module-embed.js — pure line movement, proven by the census multiset diff (RAW/IDENT (file,kind,snippet) multiset byte-identical to the landed 184 census; total flat at 514, no new sinks). Batch 181: positions shifted +4 (the album-detail video insert) and +41 (the shared detailVideoHtml helper + the renderItem branch inserts/wiring below the later sinks) — pure line movement, proven by the census multiset diff (RAW/IDENT (file,kind,snippet) multiset byte-identical to the landed 180 census; total flat at 508, no new sinks — the facade markup is a STATIC string build). Batch 180 finisher: all eleven positions shifted +60 by the H3 sandboxed Custom Code renderer block in module-embed.js — pure line movement, proven by the census multiset diff (RAW/IDENT (file,kind,snippet) multiset byte-identical to the landed 179 census; the only census delta is +1 audited STATIC sink, total 507 -> 508) (Batch 165 finisher: positions shifted by the renderWebinar insertions in module-embed.js — pure line movement, proven by the census multiset diff (RAW/IDENT multiset gains NO module-embed sink; the +1 RAW is in portal.js))
      'module-embed reviewed sinks: the same nine sinks as the Batch 130 set plus one new reviewed RAW sink (the detail mount esc()-escaped error line, Batch 133), at Batch 128 positions — shifted by the Batch 128 checkout embed blocks (pure line movement; the snippet sequence is unchanged except the album-detail sink, whose call gained the payload argument in Batch 128) plus the audited QR RAW sink; Batch 129 finisher: five positions shifted again (+52/+52/+62/+62/+62) by the Batch 129 pay-at-booking embed blocks — pure line movement, proven by the census multiset diff (RAW/IDENT multiset byte-identical, exactly +3 STATIC sinks added); Batch 135 finisher: all nine positions shifted +11 by the Batch 135 module-internal spacing floor CSS block in module-embed.js — pure line movement, census multiset then unchanged (total 437); Batch 133 finisher: positions shifted +54/+55 by the detail helpers and the set grows to ten with the one new reviewed sink (total 440); Batch 131 finisher: all ten positions shifted again (+30 x6, +401, +408 x2, +435) by the comments renderer + detail-comments mount in module-embed.js — pure line movement, census total flat at 440 and the RAW/IDENT multiset byte-identical; Batch 142 finisher: rebased onto the post-131 tree — positions re-derived on the merged module-embed.js (nav-cart block added, in-body cart bar removed): all ten sink lines byte-identical to the post-131 set (pure line movement, verified line-by-line in the finisher census diff) and the census drops one STATIC sink (two in-body cart-bar innerHTML sinks removed, one nav-cart innerHTML sink added; total 440 -> 439, STATIC 157 -> 156, RAW/IDENT multiset otherwise unchanged); Batch 143 finisher: positions shifted +1/+2 by the esc() single-quote hardening in module-embed.js (one added line in esc at the top, one in chartEscText) — pure line movement, census total flat at 439 and the RAW/IDENT multiset byte-identical; Batch 136 finisher: five positions shifted (+45, +64 x4) by the booking-widget discount banner + price-summary block in module-embed.js — pure line movement, proven by the census multiset diff (RAW/IDENT multiset byte-identical), and the census gains exactly +2 audited STATIC sinks, both in module-embed.js (the price-summary innerHTML clear at the new 1981 and the fully esc()-wrapped price-summary build at the new 1988); total 439 -> 441, STATIC 156 -> 158'
    );
    n++;
    group('Part A source pins', n);
  }

  await seed();

  const { child, output } = bootServer();
  try {
    await waitReady(child, output);

    /* ================================================================ */
    /* Part B — HTTP contract                                            */
    /* ================================================================ */
    {
      let n = 0;
      const get = async (token, qs) => {
        const res = await fetch(`${BASE}/api/v1/modules/public/${token}${qs || ''}`);
        return { status: res.status, body: await json(res) };
      };

      const list = await get(T.shop);
      assert.equal(list.status, 200, 'shop list serves');
      assert.ok(
        list.body.data.items.some((i) => i.name === 'Fixture Monstera'),
        'shop list carries the product'
      );
      n += 2;

      const own = await get(T.shop, '?slug=fixture-monstera');
      assert.equal(own.status, 200, 'owning module resolves its item');
      assert.equal(own.body.data.item.name, 'Fixture Monstera');
      n += 2;

      for (const [token, slug, label] of [
        [T.cats, 'fixture-monstera', 'categories handed a product slug'],
        [T.shop, 'fixture-shelf', 'shop handed a category slug'],
        [T.cats, 'fixture-story', 'categories handed a post slug'],
        [T.blog, 'fixture-monstera', 'blog handed a product slug'],
        [T.blog, 'nope-not-real', 'blog handed a bogus slug'],
      ]) {
        const r = await get(token, `?slug=${slug}`);
        assert.equal(r.status, 404, `${label}: HTTP 404`);
        assert.equal(r.body.ok, false, `${label}: ok false`);
        assert.equal(r.body.code, 'NOT_FOUND', `${label}: code NOT_FOUND (the fallback signal)`);
        assert.equal(r.body.error, 'Item not found', `${label}: authored message`);
        n += 4;
      }

      const post = await get(T.blog, '?slug=fixture-story');
      assert.equal(post.status, 200, 'blog resolves its own post');
      assert.equal(post.body.data.item.title, 'Fixture Story');
      n += 2;

      const gatedItem = await get(T.gatedBlog, '?slug=secret-fixture-post&bpPage=shop');
      assert.equal(gatedItem.status, 200, 'gated item fetch is NOT a 404');
      assert.equal(gatedItem.body.data.locked, true, 'gated item fetch returns the locked payload');
      assert.ok(
        !JSON.stringify(gatedItem.body).includes('Secret Fixture Post'),
        'locked payload carries no gated content'
      );
      n += 3;

      const gatedList = await get(T.gatedBlog, '?bpPage=shop');
      assert.equal(gatedList.status, 200, 'gated list fetch serves');
      assert.equal(gatedList.body.data.locked, true, 'gated list fetch is locked too');
      n += 2;

      for (const qs of ['', '?slug=fixture-monstera']) {
        const r = await get(T.unknown, qs);
        assert.equal(r.status, 404, `unknown token${qs ? ' (item form)' : ''}: 404`);
        assert.equal(r.body.code, 'NOT_FOUND', 'unknown token: NOT_FOUND in both forms');
        n += 2;
      }
      group('Part B HTTP contract', n);
    }

    /* ================================================================ */
    /* Part C — real browser                                             */
    /* ================================================================ */
    {
      let n = 0;
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      const mount = (id, token, type, api) =>
        `<div id="${id}" class="bitpype-module-embed" data-bitpype-module="1" ` +
        `data-bitpype-module-type="${type}" data-bitpype-module-token="${token}" ` +
        `data-bitpype-api="${api || BASE}" data-bitpype-hide-title="1"></div>`;
      const shopMounts = (extra) =>
        mount('m-shop', T.shop, 'ecommerce') +
        mount('m-cats', T.cats, 'categories') +
        mount('m-blog', T.blog, 'blog') +
        (extra || '');
      const openPage = async (mountsHtml, query) => {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1000 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (req.url().startsWith(`${BASE}/shop`)) {
            req.respond({
              status: 200,
              contentType: 'text/html',
              body:
                '<!doctype html><html><head><meta charset="utf-8"><title>B130 fixture</title></head><body>' +
                mountsHtml +
                `<script src="${BASE}/js/module-embed.js"></script>` +
                '</body></html>',
            });
          } else {
            req.continue();
          }
        });
        await page.goto(`${BASE}/shop${query || ''}`, { waitUntil: 'load', timeout: 45000 });
        await page
          .waitForFunction(
            () =>
              [...document.querySelectorAll('.bitpype-module-embed')].every(
                (el) => el.innerHTML.length > 30 && !el.textContent.includes('Loading…')
              ),
            { timeout: 25000 }
          )
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
        return page;
      };
      const mountText = (page, id) =>
        page.evaluate((i) => {
          const el = document.getElementById(i);
          return el ? el.textContent.replace(/\s+/g, ' ') : '';
        }, id);
      const pageText = (page) => page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
      const errCards = (page) => page.evaluate(() => document.querySelectorAll('.bp-mod-err').length);

      // C1 — Ely's screenshot: a product open on a multi-module page.
      {
        const page = await openPage(shopMounts(), '?bpItem=fixture-monstera');
        const shop = await mountText(page, 'm-shop');
        const cats = await mountText(page, 'm-cats');
        const blog = await mountText(page, 'm-blog');
        assert.ok(shop.includes('Fixture Monstera'), 'C1: product detail renders');
        assert.ok(
          await page.evaluate(() => !!document.querySelector('#m-shop .bp-mod-back')),
          'C1: the shop mount is in DETAIL view (Back link)'
        );
        assert.ok(cats.includes('Fixture Shelf'), 'C1: categories shelf renders its list');
        assert.ok(blog.includes('Fixture Story'), 'C1: blog renders its list');
        assert.ok(!(await pageText(page)).includes('Item not found'), 'C1: no Item not found anywhere');
        assert.equal(await errCards(page), 0, 'C1: no error cards');
        n += 6;
        await page.close();
      }

      // C2 — a category open: the shelf shows the category, others list.
      {
        const page = await openPage(shopMounts(), '?bpItem=fixture-shelf');
        const cats = await mountText(page, 'm-cats');
        const shop = await mountText(page, 'm-shop');
        assert.ok(cats.includes('Fixture Shelf'), 'C2: category detail renders');
        assert.ok(cats.includes('Fixture Monstera'), 'C2: category detail lists its assigned product');
        assert.ok(shop.includes('Fixture Monstera'), 'C2: shop renders its grid');
        assert.ok(
          await page.evaluate(() => !document.querySelector('#m-shop .bp-mod-back')),
          'C2: the shop mount stayed in LIST view'
        );
        assert.equal(await errCards(page), 0, 'C2: no error cards');
        n += 5;
        await page.close();
      }

      // C3 — a post open: blog detail, shop grid + shelf list.
      {
        const page = await openPage(shopMounts(), '?bpItem=fixture-story');
        const blog = await mountText(page, 'm-blog');
        assert.ok(blog.includes('Fixture Story'), 'C3: post detail renders');
        assert.ok(blog.includes('Fixture story body.'), 'C3: post body renders');
        assert.ok((await mountText(page, 'm-shop')).includes('Fixture Fern'), 'C3: shop grid renders');
        assert.ok((await mountText(page, 'm-cats')).includes('Fixture Shelf'), 'C3: shelf renders');
        assert.equal(await errCards(page), 0, 'C3: no error cards');
        n += 5;
        await page.close();
      }

      // C4 — a bogus slug lands every mount on its list, no error.
      {
        const page = await openPage(shopMounts(), '?bpItem=definitely-not-real');
        assert.ok((await mountText(page, 'm-shop')).includes('Fixture Monstera'), 'C4: shop grid renders');
        assert.ok((await mountText(page, 'm-cats')).includes('Fixture Shelf'), 'C4: shelf renders');
        assert.ok((await mountText(page, 'm-blog')).includes('Fixture Story'), 'C4: blog list renders');
        assert.ok(!(await pageText(page)).includes('Item not found'), 'C4: no Item not found');
        assert.equal(await errCards(page), 0, 'C4: no error cards');
        n += 5;
        await page.close();
      }

      // C5 — no param: exactly the pre-fix list behavior.
      {
        const page = await openPage(shopMounts(), '');
        assert.ok((await mountText(page, 'm-shop')).includes('Fixture Monstera'), 'C5: shop grid renders');
        assert.ok((await mountText(page, 'm-cats')).includes('Fixture Shelf'), 'C5: shelf renders');
        assert.ok((await mountText(page, 'm-blog')).includes('Fixture Story'), 'C5: blog list renders');
        assert.equal(await errCards(page), 0, 'C5: no error cards');
        n += 4;
        await page.close();
      }

      // C6 — a gated page with an item param still shows the wall.
      {
        const page = await openPage(mount('m-gated', T.gatedBlog, 'blog'), '?bpItem=secret-fixture-post');
        const gated = await mountText(page, 'm-gated');
        assert.ok(/members only/i.test(gated), 'C6: the members wall renders');
        assert.ok(!gated.includes('Secret Fixture Post'), 'C6: no gated content leaks');
        assert.equal(await errCards(page), 0, 'C6: the wall is not an error card');
        n += 3;
        await page.close();
      }

      // C7 — a bad token still errors: the fallback cannot rescue it
      // (its list fetch 404s too, into the same error path).
      {
        const page = await openPage(mount('m-bad', T.unknown, 'blog'), '?bpItem=fixture-monstera');
        const bad = await page.evaluate(() => {
          const el = document.getElementById('m-bad');
          return { err: !!el.querySelector('.bp-mod-err'), text: el.textContent };
        });
        assert.ok(bad.err, 'C7: error card renders for an unknown token');
        assert.ok(bad.text.includes('Module not found'), 'C7: the genuine error message survives');
        n += 2;
        await page.close();
      }

      // C8 — a dead API origin still errors (network failure is not a
      // NOT_FOUND outcome and must not silently render anything).
      {
        const page = await openPage(mount('m-dead', T.blog, 'blog', 'http://127.0.0.1:9'), '?bpItem=fixture-story');
        const dead = await page.evaluate(() => {
          const el = document.getElementById('m-dead');
          return { err: !!el.querySelector('.bp-mod-err'), text: el.textContent };
        });
        assert.ok(dead.err, 'C8: error card renders when the API is unreachable');
        assert.ok(!dead.text.includes('Fixture Story'), 'C8: no phantom list render');
        n += 2;
        await page.close();
      }

      await browser.close();
      group('Part C real browser', n);
    }
  } finally {
    child.kill('SIGKILL');
  }

  console.log(`\nBATCH130 REGRESSIONS: ALL PASS — ${groups.length} groups`);
  for (const g of groups) console.log('  - ' + g);
  process.exit(0);
})().catch((e) => {
  console.error('BATCH130 REGRESSIONS: FAIL');
  console.error((e && e.stack) || e);
  process.exit(1);
});
