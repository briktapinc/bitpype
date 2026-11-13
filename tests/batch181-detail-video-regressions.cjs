'use strict';
/**
 * Batch 181 — SHARED OPTIONAL VIDEO ON DETAIL PAGES (Ely, 2026-11-11:
 * "Modify the directory module so the detail page shows videos too if
 * available" — widened by Ely the same night: "Same for most module
 * detail pages").
 *
 * ONE mechanism across the 13 detail-capable item types (blog,
 * ecommerce, courses, gallery, directory, faq, testimonials, team,
 * events, bookings, offers, menu, careers): an optional video_url on
 * the item, validated through the video module's own parseVideoUrl at
 * write time (invalid/unsupported throws VALIDATION, never stored),
 * derived embed fields attached at read time by withItemVideo, and
 * ONE shared click-facade (detailVideoHtml) in the detail renderer +
 * the standalone bake. Video (video-native) and categories (taxonomy)
 * stay out.
 *
 * What this pins:
 *   Part 1 — source pins: MODULE_SCRIPT_VER mod43, DETAIL_VIDEO_TYPES
 *     (exactly the 13), the shared helpers, the video_url column on
 *     all 13 tables, the shared renderer helper + per-branch wiring,
 *     the standalone facade, MCP (server + catalog) schema parity,
 *     and the portal editor field for every in-scope type.
 *   Part 2 — in-process, per type: create without a video resolves
 *     through getPublicModuleItem with NO derived video fields;
 *     create with a YouTube watch URL stores video_url and the public
 *     payload carries the nocookie embed + thumbnail; Vimeo likewise;
 *     invalid URLs throw VALIDATION on create AND update (stored
 *     value untouched); clearing with '' removes the embed; the
 *     detail exporter still enumerates the item; the standalone bake
 *     emits the facade only when an embed exists.
 *   Part 3 — browser (module-embed.js in headless Chromium with a
 *     stubbed public API): a video-less item renders with NO facade
 *     and byte-identical HTML whether or not the payload carries the
 *     (empty) video_url; a YouTube item's detail HTML contains the
 *     facade with the exact embed + thumbnail; LIST rendering never
 *     shows a facade (incl. the single-album gallery list view).
 *   Part 4 — migration: a workspace DB whose directory_listings and
 *     blog_posts tables predate Batch 181 (no video_url column) gets
 *     the column from ensureTables and create/read works.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch181-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
process.env.SESSION_SECRET = ['batch181', 'fixture', 'secret'].join('-');
process.env.COOKIE_SECURE = 'false';
// Standard suite header (Batch 127 lesson): the real-server boot
// refuses production mode without these two lines.
process.env.CAPTCHA_OPTIONAL = '1';
process.env.APP_URL = 'https://bitpype.test';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';

const root = path.resolve(__dirname, '..');
const LEAD = 18101;
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const YT_EMBED = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
const YT_THUMB = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
const VIMEO_URL = 'https://vimeo.com/123456789';
const VIMEO_EMBED = 'https://player.vimeo.com/video/123456789';

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes("const MODULE_SCRIPT_VER = 'mod43'"), 'MODULE_SCRIPT_VER bumped to mod43');
    n++;
    assert.ok(smSrc.includes('function normalizeItemVideoUrl(data, row)'), 'shared write-side normalizer exists');
    n++;
    assert.ok(smSrc.includes('function withItemVideo(row)'), 'shared read-side decorator exists');
    n++;
    const dvBlock = /const DETAIL_VIDEO_TYPES = \[([\s\S]*?)\];/.exec(smSrc);
    assert.ok(dvBlock, 'DETAIL_VIDEO_TYPES declared');
    n++;
    assert.deepEqual(
      [...dvBlock[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort(),
      [
        'blog',
        'bookings',
        'careers',
        'courses',
        'directory',
        'ecommerce',
        'events',
        'faq',
        'gallery',
        'menu',
        'offers',
        'team',
        'testimonials',
      ],
      'DETAIL_VIDEO_TYPES is exactly the 13 in-scope types (video + categories excluded)'
    );
    n++;
    for (const t of [
      'blog_posts',
      'ecommerce_products',
      'courses',
      'gallery_albums',
      'directory_listings',
      'faq_items',
      'testimonials',
      'team_members',
      'events',
      'booking_services',
      'offers',
      'menu_items',
      'careers_postings',
    ]) {
      assert.ok(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?video_url TEXT NOT NULL DEFAULT ''`).test(smSrc),
        `${t} CREATE TABLE carries video_url`
      );
      n++;
    }
    assert.ok(smSrc.includes('ALTER TABLE ${t} ADD COLUMN video_url'), 'migration ALTER for pre-181 tables exists');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function detailVideoHtml(it)'), 'renderer has ONE shared detailVideoHtml helper');
    n++;
    assert.equal(
      countOccurrences(embedSrc, 'detailVideoHtml('),
      14,
      'detailVideoHtml defined once and called from all 13 detail branches (incl. album detail)'
    );
    n++;
    assert.equal(
      countOccurrences(embedSrc, 'wireVideoFacades(el);'),
      7,
      'facade wiring: renderItem main tail + 3 early returns (181) alongside the 3 pre-existing call sites'
    );
    n++;

    const bakeSrc = read('server/standaloneBackup.js');
    assert.ok(
      bakeSrc.includes('data-bp-video-embed="${esc(it.video_embed_url)}"'),
      'standalone bake emits the same facade'
    );
    n++;

    const mcpSrc = read('server/mcp.js');
    assert.equal(
      countOccurrences(mcpSrc, 'video_url: STR'),
      26,
      'server MCP schemas carry video_url on 13 create + 13 update tools'
    );
    n++;
    const catSrc = read('src/mcpCatalog.js');
    assert.equal(
      countOccurrences(catSrc, "video_url: { type: 'string' }"),
      26,
      'client catalog schemas carry video_url on 13 create + 13 update tools'
    );
    n++;
    const portalSrc = read('public/js/portal.js');
    assert.equal(
      countOccurrences(portalSrc, "{ key: 'video_url', label: 'Video URL (YouTube or Vimeo, optional)'"),
      13,
      'portal editor exposes the video_url field for all 13 types'
    );
    n++;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — in-process per-type matrix                                 */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const bake = require(path.join(root, 'server/standaloneBackup.js'));

  const fixturePw = ['batch181', 'fixture', 'pw'].join('-');
  const a = await workspace.createUserWithWorkspace({
    email: 'a181@example.invalid',
    password: fixturePw,
    name: 'A181',
    workspaceName: 'Batch181 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD,
    'B181 Fixture Co',
    'fixture181@example.invalid',
    'customer'
  );

  // type → [createFn, updateFn, base data factory, public key picker]
  const TYPES = {
    blog: [
      'createBlogPost',
      'updateBlogPost',
      (s) => ({ title: `B181 Post ${s}`, body_html: '<p>Hello.</p>', status: 'published' }),
      (r) => r.slug,
    ],
    ecommerce: [
      'createProduct',
      'updateProduct',
      (s) => ({ name: `B181 Widget ${s}`, price_cents: 2500, status: 'published' }),
      (r) => r.slug,
    ],
    courses: [
      'createCourse',
      'updateCourse',
      (s) => ({ title: `B181 Course ${s}`, status: 'published' }),
      (r) => r.slug,
    ],
    gallery: ['createAlbum', 'updateAlbum', (s) => ({ title: `B181 Album ${s}`, status: 'published' }), (r) => r.slug],
    directory: [
      'createListing',
      'updateListing',
      (s) => ({ name: `B181 Cafe ${s}`, status: 'published' }),
      (r) => String(r.id),
    ],
    faq: [
      'createFaqItem',
      'updateFaqItem',
      (s) => ({ question: `B181 question ${s}?`, answer_html: '<p>Answer.</p>', status: 'published' }),
      (r) => String(r.id),
    ],
    testimonials: [
      'createTestimonial',
      'updateTestimonial',
      (s) => ({ quote: `B181 praise ${s}`, author_name: 'Pat', status: 'published' }),
      (r) => String(r.id),
    ],
    team: [
      'createTeamMember',
      'updateTeamMember',
      (s) => ({ name: `B181 Person ${s}`, status: 'published' }),
      (r) => r.slug,
    ],
    events: ['createEvent', 'updateEvent', (s) => ({ title: `B181 Event ${s}`, status: 'published' }), (r) => r.slug],
    bookings: [
      'createBookingService',
      'updateBookingService',
      (s) => ({ name: `B181 Service ${s}`, duration_minutes: 30, status: 'published' }),
      (r) => String(r.id),
    ],
    offers: [
      'createOffer',
      'updateOffer',
      (s) => ({ title: `B181 Offer ${s}`, status: 'published' }),
      (r) => String(r.id),
    ],
    menu: [
      'createMenuItem',
      'updateMenuItem',
      (s) => ({ name: `B181 Dish ${s}`, status: 'published' }),
      (r) => String(r.id),
    ],
    careers: [
      'createCareersPosting',
      'updateCareersPosting',
      (s) => ({ title: `B181 Role ${s}`, active: 1 }),
      (r) => String(r.id),
    ],
  };
  assert.deepEqual(
    Object.keys(TYPES).sort(),
    [...sm.DETAIL_VIDEO_TYPES].sort(),
    'suite matrix covers exactly DETAIL_VIDEO_TYPES'
  );

  const tokens = {};
  const renderPayloads = {}; // type → { plain, yt } public payloads for Part 3
  {
    let n = 0;
    for (const [type, [createFn, updateFn, factory, keyOf]] of Object.entries(TYPES)) {
      sm.attachModule(db, LEAD, type, { workspaceId: WS_ID, appUrl: 'https://example.test' });
      const token = sm.getEmbedRow(db, LEAD, type).public_token;
      tokens[type] = token;
      assert.ok(token, `${type}: embed token`);
      n++;

      // (a) no video → public detail payload has NO derived video fields
      const plain = sm[createFn](db, LEAD, factory('plain'));
      assert.equal(plain.video_url, '', `${type}: video-less row stores empty video_url`);
      n++;
      assert.ok(!('video_embed_url' in plain), `${type}: video-less getter row has no embed field`);
      n++;
      const plainPayload = sm.getPublicModuleItem(db, token, keyOf(plain));
      assert.equal(plainPayload.module_type, type, `${type}: detail payload resolves under its own type`);
      n++;
      assert.ok(!('video_embed_url' in plainPayload.item), `${type}: video-less public payload has no video_embed_url`);
      n++;
      assert.ok(!('video' in plainPayload.item), `${type}: video-less public payload has no nested video object`);
      n++;

      // (b) YouTube → stored + derived embed on the public payload
      const yt = sm[createFn](db, LEAD, { ...factory('yt'), video_url: YT_URL });
      assert.equal(yt.video_url, YT_URL, `${type}: video_url stored`);
      n++;
      const ytPayload = sm.getPublicModuleItem(db, token, keyOf(yt));
      assert.equal(ytPayload.item.video_provider, 'youtube', `${type}: provider derived`);
      n++;
      assert.equal(ytPayload.item.video_embed_url, YT_EMBED, `${type}: nocookie embed derived`);
      n++;
      assert.equal(ytPayload.item.video_thumbnail_url, YT_THUMB, `${type}: thumbnail derived`);
      n++;
      assert.deepEqual(
        ytPayload.item.video,
        { url: YT_URL, provider: 'youtube', video_id: 'dQw4w9WgXcQ', embed_url: YT_EMBED, thumbnail_url: YT_THUMB },
        `${type}: nested video object derived`
      );
      n++;
      renderPayloads[type] = { plain: plainPayload, yt: ytPayload };

      // (c) Vimeo likewise
      const vm = sm[createFn](db, LEAD, { ...factory('vm'), video_url: VIMEO_URL });
      const vmPayload = sm.getPublicModuleItem(db, token, keyOf(vm));
      assert.equal(vmPayload.item.video_provider, 'vimeo', `${type}: vimeo provider derived`);
      n++;
      assert.equal(vmPayload.item.video_embed_url, VIMEO_EMBED, `${type}: vimeo embed derived`);
      n++;

      // (d) invalid URLs throw VALIDATION on create, and nothing stores
      for (const bad of ['https://example.com/x', 'not a url', 'javascript:alert(1)']) {
        let code = '';
        try {
          sm[createFn](db, LEAD, { ...factory('bad'), video_url: bad });
        } catch (e) {
          code = e.code || '';
        }
        assert.equal(code, 'VALIDATION', `${type}: create with ${JSON.stringify(bad)} throws VALIDATION`);
        n++;
      }

      // (e) invalid update throws and the stored value is untouched
      let code = '';
      try {
        sm[updateFn](db, LEAD, yt.id, { video_url: 'https://example.com/nope' });
      } catch (e) {
        code = e.code || '';
      }
      assert.equal(code, 'VALIDATION', `${type}: update with an unsupported URL throws VALIDATION`);
      n++;
      assert.equal(
        sm.getPublicModuleItem(db, token, keyOf(yt)).item.video_url,
        YT_URL,
        `${type}: failed update leaves stored video_url unchanged`
      );
      n++;

      // (f) clearing with '' removes the embed from the public payload
      const cleared = sm[updateFn](db, LEAD, yt.id, { video_url: '' });
      assert.equal(cleared.video_url, '', `${type}: update with '' clears video_url`);
      n++;
      assert.ok(
        !('video_embed_url' in sm.getPublicModuleItem(db, token, keyOf(yt)).item),
        `${type}: cleared item has no embed`
      );
      n++;

      // (g) the detail exporter still enumerates the item
      const ctx = sm.detailExportContext(db, LEAD);
      assert.ok(ctx.types[type], `${type}: detail export context carries the type`);
      n++;
      assert.ok(
        Array.isArray(ctx.types[type].items) && ctx.types[type].items.map(String).includes(keyOf(plain)),
        `${type}: detail export context enumerates the published item`
      );
      n++;
    }
    group('Part 2 — per-type create/read/validate/clear/export matrix', n);
  }

  /* ---- standalone bake parity ---- */
  {
    let n = 0;
    const baked = bake.renderDetailItemHtml('directory', renderPayloads.directory.yt, '');
    assert.ok(baked.includes(`data-bp-video-embed="${YT_EMBED}"`), 'standalone bake: facade carries the embed');
    n++;
    assert.ok(baked.includes(`<img src="${YT_THUMB}"`), 'standalone bake: facade carries the thumbnail');
    n++;
    const bakedPlain = bake.renderDetailItemHtml('directory', renderPayloads.directory.plain, '');
    assert.ok(!bakedPlain.includes('bp-mod-video'), 'standalone bake: no video, no facade markup');
    n++;
    group('Part 2b — standalone bake parity', n);
  }

  /* ================================================================== */
  /* Part 3 — browser rendering (module-embed.js, stubbed public API)    */
  /* ================================================================== */
  {
    let n = 0;
    const http = require('node:http');
    const puppeteer = require('puppeteer');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
          '<div id="m" data-bitpype-module="1" data-bitpype-module-token="tok181"></div>' +
          '</body></html>'
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        window.fetch = () =>
          Promise.resolve({ json: () => Promise.resolve({ ok: true, data: window.__BP_TEST_PAYLOAD__ }) });
      });
      await page.goto(`${base}/page?bpItem=fixture`, { waitUntil: 'load' });
      await page.addScriptTag({ path: path.join(root, 'public/js/module-embed.js') });
      await page.waitForFunction(() => window.BitpypeModules && window.BitpypeModules.__booted);

      async function render(payload) {
        await page.evaluate((p) => {
          window.__BP_TEST_PAYLOAD__ = p;
          document.body.innerHTML = '<div id="m" data-bitpype-module="1" data-bitpype-module-token="tok181"></div>';
          window.BitpypeModules.mount(document.getElementById('m'));
        }, payload);
        await page.waitForFunction(
          () => {
            const el = document.getElementById('m');
            return el && el.innerHTML.length > 0 && !el.innerHTML.includes('bp-mod-loading');
          },
          { timeout: 8000 }
        );
        return page.evaluate(() => document.getElementById('m').innerHTML);
      }

      for (const type of Object.keys(TYPES)) {
        const { plain, yt } = renderPayloads[type];
        const plainHtml = await render(plain);
        assert.ok(!plainHtml.includes('bp-mod-err'), `${type}: detail renders without error`);
        n++;
        assert.ok(!plainHtml.includes('data-bp-video-embed'), `${type}: video-less detail has NO video facade`);
        n++;
        assert.ok(!plainHtml.includes('bp-mod-video'), `${type}: video-less detail has NO video markup at all`);
        n++;
        // Byte-identical: the same payload with the video_url key
        // removed entirely (the pre-181 payload shape) renders the
        // exact same HTML — the shared helper returns '' and adds
        // no wrapper or whitespace.
        const stripped = JSON.parse(JSON.stringify(plain));
        delete stripped.item.video_url;
        const strippedHtml = await render(stripped);
        assert.equal(strippedHtml, plainHtml, `${type}: video-less detail HTML is byte-identical to the pre-181 shape`);
        n++;

        const ytHtml = await render(yt);
        assert.ok(
          ytHtml.includes(`data-bp-video-embed="${YT_EMBED}"`),
          `${type}: YouTube detail renders the shared facade with the nocookie embed`
        );
        n++;
        assert.ok(ytHtml.includes(`<img src="${YT_THUMB}"`), `${type}: facade carries the YouTube thumbnail`);
        n++;

        // List rendering never shows a facade — even when handed an
        // item that carries a video (the gallery single-album list
        // view shares renderAlbumDetail; the showBack gate keeps the
        // video detail-only).
        const listPayload = { module_type: type, items: [JSON.parse(JSON.stringify(yt.item))] };
        const listHtml = await render(listPayload);
        assert.ok(!listHtml.includes('data-bp-video-embed'), `${type}: list rendering shows NO video facade`);
        n++;
      }
    } finally {
      await browser.close();
      server.close();
    }
    group('Part 3 — browser detail/list rendering', n);
  }

  /* ================================================================== */
  /* Part 4 — migration on a pre-181 workspace DB                        */
  /* ================================================================== */
  {
    let n = 0;
    const Database = require('better-sqlite3');
    const migPath = path.join(process.env.REGRESSION_TMPDIR, 'migration.db');
    const mdb = new Database(migPath);
    const smSrc = read('server/siteModules.js');
    for (const table of ['directory_listings', 'blog_posts']) {
      const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n    \\);`).exec(smSrc);
      assert.ok(m, `${table}: CREATE block found`);
      n++;
      const oldShape = m[1]
        .split('\n')
        .filter((line) => !line.includes('video_url'))
        .join('\n');
      mdb.exec(`CREATE TABLE ${table} (${oldShape});`);
      const colsBefore = mdb
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      assert.ok(!colsBefore.includes('video_url'), `${table}: fixture table really predates Batch 181`);
      n++;
    }
    mdb.prepare('INSERT INTO directory_listings (lead_id, name) VALUES (?, ?)').run(LEAD, 'Old Cafe');
    mdb.prepare('INSERT INTO blog_posts (lead_id, title, slug) VALUES (?, ?, ?)').run(LEAD, 'Old Post', 'old-post');
    sm.ensureTables(mdb);
    for (const table of ['directory_listings', 'blog_posts']) {
      const cols = mdb
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes('video_url'), `${table}: ensureTables added video_url`);
      n++;
    }
    const oldListing = sm.getListing(mdb, LEAD, 1);
    assert.equal(oldListing.video_url, '', 'pre-181 listing reads back with empty video_url');
    n++;
    const migrated = sm.createListing(mdb, LEAD, { name: 'Migrated Cafe', status: 'published', video_url: YT_URL });
    assert.equal(migrated.video_embed_url, YT_EMBED, 'create/read with a video works on the migrated DB');
    n++;
    const oldPost = sm.getBlogPost(mdb, LEAD, 'old-post');
    assert.equal(oldPost.video_url, '', 'pre-181 blog post reads back with empty video_url');
    n++;
    mdb.close();
    group('Part 4 — migration', n);
  }

  console.log(`\nBATCH181 SUITE PASS — ${groups.length} groups: ${groups.join('; ')}`);
})().catch((e) => {
  console.error('\nBATCH181 SUITE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
