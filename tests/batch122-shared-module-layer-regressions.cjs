'use strict';
/**
 * Batch 122 — THE SHARED MODULE LAYER (Ely's order 2026-11-03:
 * modules are interdependent through ONE common layer, "that way
 * the agent has more flexibility in what it can create, and this
 * goes with all newer modules to be built in").
 *
 * What is pinned here:
 *   Part 1 — the standing rule + registry parity: SHARE_REGISTRY
 *     covers MODULE_TYPES exactly (a future type without a registry
 *     entry fails here); every provider has a reader, every
 *     non-provider an explicit reason. Agent fences: shared reads in
 *     the read allowlist, shared.link/unlink design-write + mutate.
 *     MCP catalog + dispatch carry the five shared.* tools; the
 *     portal pickers, the event editor field, the newsletter block
 *     wiring and the embed's shared-gallery rendering are present.
 *   Part 2 — engine (in-process): uniform items (published-only,
 *     expired offers excluded), lead isolation (another lead's items
 *     never returned, cross-lead refs refused), shared refs CRUD,
 *     the event→album link through events create/update (the same
 *     field the portal editor and MCP use), dormant resolution
 *     (draft album / empty album / no link → nothing), the public
 *     item payload carrying shared_gallery, newsletter blocks
 *     resolved at preview and FROZEN into the send (send content is
 *     byte-identical to the preview even after the source data
 *     changes; block-selection mismatches are PREVIEW_REQUIRED),
 *     empty-source notes, the events block's upcoming-only filter,
 *     and the agent tool surface exercised through mcp.callTool.
 *   Part 3 — HTTP over the real server: portal owner signs in and
 *     uses the shared sources/items endpoints, links an album to an
 *     event through the generic module route (the editor's path),
 *     the public event payload serves the gallery, the newsletter
 *     preview over HTTP reports its blocks, anonymous is refused.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b122-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch122', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 18).toString('base64');

const PORT = 31483;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch122', 'fixture', 'password'].join('-');

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

const LEAD_A = 12201;
const LEAD_B = 12202;
let WS_ID;
let db;

const dayMs = 24 * 60 * 60 * 1000;
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);

(async () => {
  /* ================================================================== */
  /* Part 1 — standing rule, registry parity, agent + UI surface pins    */
  /* ================================================================== */
  {
    let n = 0;
    const share = require(path.join(root, 'server/moduleShare.js'));
    const sm = require(path.join(root, 'server/siteModules.js'));

    const src = read('server/moduleShare.js');
    assert.ok(src.includes('INTERDEPENDENT'), 'moduleShare header states the interdependence rule');
    n++;
    assert.ok(src.includes('all newer modules'), "moduleShare header carries Ely's standing rule for newer modules");
    n++;

    // THE parity pin: registry ⇔ MODULE_TYPES, exactly.
    const regTypes = Object.keys(share.SHARE_REGISTRY).sort();
    const modTypes = [...sm.MODULE_TYPES].sort();
    assert.deepEqual(regTypes, modTypes, 'share registry covers every module type exactly');
    n++;
    for (const type of sm.MODULE_TYPES) {
      const entry = share.SHARE_REGISTRY[type];
      if (entry.kind === 'provider') {
        assert.equal(typeof entry.read, 'function', `${type} provider has a reader`);
      } else {
        assert.equal(entry.kind, 'none', `${type} is provider or explicit non-provider`);
        assert.ok(
          typeof entry.reason === 'string' && entry.reason.length >= 20,
          `${type} non-provider reason is explicit`
        );
      }
      n++;
    }
    const providers = sm.MODULE_TYPES.filter((t) => share.SHARE_REGISTRY[t].kind === 'provider');
    for (const must of ['events', 'gallery', 'offers', 'socialfeed', 'blog', 'menu', 'testimonials', 'faq']) {
      assert.ok(providers.includes(must), `${must} is a provider`);
      n++;
    }
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod31', 'embed script version bumped for the shared-gallery rendering');
    n++;

    // Agent fences.
    const tools = require(path.join(root, 'server/museAgentTools.js'));
    for (const t of ['shared.sources', 'shared.items', 'shared.refs']) {
      assert.ok(tools.PORTAL_READONLY_TOOLS.has(t), `${t} is a portal read tool`);
      n++;
    }
    for (const t of ['shared.link', 'shared.unlink']) {
      assert.ok(tools.PORTAL_DESIGN_WRITE_TOOLS.has(t), `${t} is a design write tool`);
      assert.ok(tools.PORTAL_MUTATE_TOOLS.has(t), `${t} refreshes the preview after mutation`);
      n += 2;
    }
    assert.equal(tools.portalModeAllowsTool('answer', 'shared.items'), true, 'answer mode may read shared items');
    n++;
    assert.equal(tools.portalModeAllowsTool('answer', 'shared.link'), false, 'answer mode may NOT link');
    n++;
    assert.equal(tools.portalModeAllowsTool('build', 'shared.link'), true, 'build mode may link');
    n++;

    // MCP catalogs + dispatch.
    const catalog = read('src/mcpCatalog.js');
    const mcpSrc = read('server/mcp.js');
    for (const t of ['shared.sources', 'shared.items', 'shared.refs', 'shared.link', 'shared.unlink']) {
      assert.ok(catalog.includes(`name: '${t}'`), `mcpCatalog carries ${t}`);
      assert.ok(mcpSrc.includes(`name: '${t}'`), `mcp tool defs carry ${t}`);
      assert.ok(mcpSrc.includes(`name === '${t}'`), `mcp dispatch handles ${t}`);
      assert.ok(mcpSrc.includes(`'${t}',`), `moduleToolNames gates ${t}`);
      n += 4;
    }
    const paritySrc = read('src/mcpParityTools.js');
    assert.ok(paritySrc.includes("'shared.sources': parityEntry("), 'local MCP parity implements shared.sources');
    assert.ok(paritySrc.includes("'shared.link': parityEntry("), 'local MCP parity implements shared.link');
    n += 2;

    // Portal + embed + census wiring.
    const portalJs = read('public/js/portal.js');
    assert.ok(
      portalJs.includes('/modules/shared/items?source=gallery'),
      'event editor loads albums from the shared layer'
    );
    n++;
    assert.ok(portalJs.includes("key: 'gallery_album_id'"), 'event editor has the gallery album field');
    n++;
    assert.ok(portalJs.includes('blocks: selectedBlocks()'), 'newsletter composer sends its block selection');
    n++;
    assert.ok(
      portalJs.includes('const current = moduleState.nlPreview || null;'),
      'composer preview renders the in-session preview (showPreview reads current state, not the render-time const)'
    );
    n++;
    const embedJs = read('public/js/module-embed.js');
    assert.ok(embedJs.includes('shared_gallery'), 'embed renders the shared gallery on event detail');
    n++;
    const chatSrc = read('server/portalSiteChat.js');
    assert.ok(chatSrc.includes("require('./moduleShare')"), 'design-chat census reads the shared layer');
    assert.ok(chatSrc.includes('Shared content'), 'census names the shared sources for the agent');
    n += 2;
    const routesSrc = read('server/routes/portal.js');
    for (const r of ['/modules/shared/sources', '/modules/shared/items', '/modules/shared/refs']) {
      assert.ok(routesSrc.includes(`'${r}'`), `portal route ${r} exists`);
      n++;
    }
    group('Part 1 standing rule + registry parity + surface pins', n);
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
  const nl = require(path.join(root, 'server/newsletter.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a122@example.invalid',
    password: ['batch122', 'ws', 'password'].join('-'),
    name: 'A122',
    workspaceName: 'Batch122 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a122@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B122 Alpha Cuts', 'alpha122@example.invalid'],
    [LEAD_B, 'B122 Beta Lawns', 'beta122@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'Alpha Site',
    '{}',
    JSON.stringify([{ slug: 'home', title: 'Home', html: '<p>hi</p>' }]),
    'draft'
  );

  // ---- Fixtures: lead A content across modules ----
  const albumA = sm.createAlbum(db, LEAD_A, {
    title: 'Shop Opening Photos',
    status: 'published',
    images: [
      { image_url: 'https://img.example/a1.jpg', caption: 'Front door' },
      { image_url: 'https://img.example/a2.jpg', caption: 'The crew' },
    ],
  });
  const albumDraft = sm.createAlbum(db, LEAD_A, {
    title: 'Unpublished Album',
    status: 'draft',
    images: [{ image_url: 'https://img.example/draft1.jpg', caption: 'Draft pic' }],
  });
  const albumEmpty = sm.createAlbum(db, LEAD_A, { title: 'Empty Album', status: 'published', images: [] });
  const eventFuture = sm.createEvent(db, LEAD_A, {
    title: 'Grand Opening Day',
    starts_at: ymd(7),
    location: 'Main St',
    status: 'published',
    description: 'Come celebrate with us.',
  });
  const eventPast = sm.createEvent(db, LEAD_A, {
    title: 'Last Month Meetup',
    starts_at: ymd(-7),
    status: 'published',
    description: 'Already happened.',
  });
  const eventDraft = sm.createEvent(db, LEAD_A, { title: 'Secret Draft Event', starts_at: ymd(9), status: 'draft' });
  const offerLive = sm.createOffer(db, LEAD_A, {
    title: 'Spring Cut Special',
    description: 'Twenty percent off.',
    status: 'published',
    expires_at: ymd(30),
  });
  sm.createOffer(db, LEAD_A, { title: 'Expired Special', status: 'published', expires_at: ymd(-2) });
  sm.createOffer(db, LEAD_A, { title: 'Draft Special', status: 'draft', expires_at: ymd(30) });
  sm.createBlogPost(db, LEAD_A, { title: 'Hello From The Blog', body_html: '<p>First post</p>', status: 'published' });
  sm.createBlogPost(db, LEAD_A, { title: 'Draft Post', body_html: '<p>Hidden</p>', status: 'draft' });
  sm.createFaqItem(db, LEAD_A, {
    question: 'Do you take walk-ins?',
    answer_html: '<p>Yes, daily.</p>',
    status: 'published',
  });
  require(path.join(root, 'src/socialMedia.js')).ensureTables(db);
  db.prepare(
    `INSERT INTO social_posts (campaign_id, lead_id, caption, platforms, image_url, status, published_at)
     VALUES (1, ?, ?, '["facebook"]', '', 'posted', ?)`
  ).run(LEAD_A, 'Fresh cut Friday — book your slot!', '2026-11-01 10:00:00');
  db.prepare(
    `INSERT INTO social_posts (campaign_id, lead_id, caption, platforms, image_url, status, published_at)
     VALUES (1, ?, ?, '["facebook"]', '', 'draft', ?)`
  ).run(LEAD_A, 'Unpublished social draft', '2026-11-01 11:00:00');

  // ---- Fixtures: lead B (isolation) ----
  const albumB = sm.createAlbum(db, LEAD_B, {
    title: 'Beta Only Album',
    status: 'published',
    images: [{ image_url: 'https://img.example/b1.jpg', caption: 'Beta pic' }],
  });
  sm.createEvent(db, LEAD_B, { title: 'Beta Event', starts_at: ymd(3), status: 'published' });

  {
    let n = 0;
    const sources = share.listSharedSources(db, LEAD_A, { sample: 2 });
    assert.equal(sources.length, sm.MODULE_TYPES.length, 'one source row per module type');
    n++;
    const byType = Object.fromEntries(sources.map((s) => [s.type, s]));
    assert.equal(byType.events.kind, 'provider');
    assert.equal(byType.events.count, 2, 'events count published only (draft excluded)');
    n += 2;
    assert.equal(byType.gallery.count, 2, 'gallery counts published albums (draft excluded)');
    n++;
    assert.equal(byType.offers.count, 1, 'offers exclude expired + draft');
    n++;
    assert.equal(byType.blog.count, 1, 'blog excludes drafts');
    n++;
    assert.equal(byType.socialfeed.count, 1, 'socialfeed counts posted posts only');
    n++;
    assert.equal(byType.chatbot.kind, 'none', 'chatbot is an explicit non-provider');
    assert.ok(byType.chatbot.reason.includes('knowledge'), 'chatbot reason recorded');
    n += 2;
    assert.equal(byType.newsletter.kind, 'none', 'newsletter is a consumer, not a provider');
    n++;

    const items = share.listSharedItems(db, LEAD_A, 'events');
    assert.equal(items.length, 2);
    const fut = items.find((i) => i.title === 'Grand Opening Day');
    assert.ok(fut, 'future event shared');
    assert.deepEqual(
      Object.keys(fut).sort(),
      ['date', 'description', 'image_url', 'link_url', 'meta', 'source_id', 'source_type', 'title'],
      'uniform item shape'
    );
    assert.equal(fut.source_type, 'events');
    assert.equal(fut.date, ymd(7));
    assert.equal(fut.meta.location, 'Main St');
    n += 6;

    const galleryItems = share.listSharedItems(db, LEAD_A, 'gallery');
    const shop = galleryItems.find((i) => i.title === 'Shop Opening Photos');
    assert.equal(shop.meta.image_count, 2, 'album item carries its photos in meta');
    assert.equal(shop.image_url, 'https://img.example/a1.jpg', 'album cover is its first photo');
    n += 2;

    const social = share.listSharedItems(db, LEAD_A, 'socialfeed');
    assert.equal(social.length, 1);
    assert.ok(social[0].title.includes('Fresh cut Friday'), 'social item text flows through');
    assert.equal(social[0].meta.network, 'facebook');
    n += 3;

    assert.throws(
      () => share.listSharedItems(db, LEAD_A, 'chatbot'),
      (e) => e.code === 'VALIDATION',
      'non-provider read refused with its reason'
    );
    n++;
    assert.throws(
      () => share.listSharedItems(db, LEAD_A, 'nope'),
      (e) => e.code === 'VALIDATION',
      'unknown source refused'
    );
    n++;
    group('Part 2a sources + uniform items (published-only)', n);
  }

  {
    let n = 0;
    // Isolation: B's content never appears in A's reads and vice versa.
    const aGallery = share.listSharedItems(db, LEAD_A, 'gallery');
    assert.ok(!aGallery.some((i) => Number(i.source_id) === albumB.id), "B's album never in A's items");
    n++;
    const bGallery = share.listSharedItems(db, LEAD_B, 'gallery');
    assert.equal(bGallery.length, 1);
    assert.equal(bGallery[0].title, 'Beta Only Album');
    n += 2;
    const bEvents = share.listSharedItems(db, LEAD_B, 'events');
    assert.equal(bEvents.length, 1, 'B sees only its own event');
    n++;
    // Cross-lead ref refused even though the album id exists in the DB.
    assert.throws(
      () =>
        share.setSharedRef(db, LEAD_A, {
          consumer_type: 'events',
          consumer_id: eventFuture.id,
          provider_type: 'gallery',
          provider_id: albumB.id,
          role: 'album',
        }),
      (e) => e.code === 'VALIDATION',
      "ref to another lead's album refused"
    );
    n++;
    // Draft provider items cannot be linked through the generic path.
    assert.throws(
      () =>
        share.setSharedRef(db, LEAD_A, {
          consumer_type: 'events',
          consumer_id: eventFuture.id,
          provider_type: 'gallery',
          provider_id: albumDraft.id,
          role: 'album',
        }),
      (e) => e.code === 'VALIDATION',
      'ref to a draft album refused (not a published shared item)'
    );
    n++;
    group('Part 2b lead isolation', n);
  }

  {
    let n = 0;
    // The event→album link through the events write path — the same
    // field the portal editor, MCP events.update and the agent use.
    const linked = sm.updateEvent(db, LEAD_A, eventFuture.id, { gallery_album_id: albumA.id });
    assert.equal(linked.gallery_album_id, albumA.id, 'update returns the linked album');
    n++;
    assert.equal(sm.getEvent(db, LEAD_A, eventFuture.id).gallery_album_id, albumA.id, 'link persists on read');
    n++;
    const refs = share.listSharedRefs(db, LEAD_A, { consumer_type: 'events', consumer_id: eventFuture.id });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].provider_type, 'gallery');
    assert.equal(refs[0].role, 'album');
    n += 3;

    const resolved = share.resolveEventGallery(db, LEAD_A, sm.getEvent(db, LEAD_A, eventFuture.id));
    assert.ok(resolved, 'linked published album resolves');
    assert.equal(resolved.album_title, 'Shop Opening Photos');
    assert.equal(resolved.images.length, 2);
    assert.equal(resolved.images[1].caption, 'The crew');
    n += 4;

    // Create-with-link + bogus album refused without creating.
    const created = sm.createEvent(db, LEAD_A, {
      title: 'Linked At Birth',
      starts_at: ymd(12),
      status: 'published',
      gallery_album_id: albumA.id,
    });
    assert.equal(created.gallery_album_id, albumA.id, 'create accepts gallery_album_id');
    n++;
    assert.throws(
      () => sm.createEvent(db, LEAD_A, { title: 'Bogus Link', gallery_album_id: 999999 }),
      (e) => e.code === 'VALIDATION',
      'bogus album id refused'
    );
    n++;
    assert.ok(!sm.listEvents(db, LEAD_A).some((e) => e.title === 'Bogus Link'), 'refused create left no event');
    n++;

    // Dormant resolution: draft album links ahead but renders nothing.
    const draftLinked = sm.updateEvent(db, LEAD_A, eventPast.id, { gallery_album_id: albumDraft.id });
    assert.equal(draftLinked.gallery_album_id, albumDraft.id, 'draft album may be linked ahead');
    n++;
    assert.equal(
      share.resolveEventGallery(db, LEAD_A, sm.getEvent(db, LEAD_A, eventPast.id)),
      null,
      'draft album resolves to nothing'
    );
    n++;
    // Empty album resolves to nothing; no link resolves to nothing.
    sm.updateEvent(db, LEAD_A, eventPast.id, { gallery_album_id: albumEmpty.id });
    assert.equal(
      share.resolveEventGallery(db, LEAD_A, sm.getEvent(db, LEAD_A, eventPast.id)),
      null,
      'empty album resolves to nothing'
    );
    n++;
    assert.equal(
      share.resolveEventGallery(db, LEAD_A, sm.getEvent(db, LEAD_A, eventDraft.id)),
      null,
      'unlinked event resolves to nothing'
    );
    n++;

    // Clear via 0 (the editor's "No gallery" value).
    const cleared = sm.updateEvent(db, LEAD_A, eventFuture.id, { gallery_album_id: 0 });
    assert.equal(cleared.gallery_album_id, null, 'gallery_album_id 0 clears the link');
    n++;
    assert.equal(share.listSharedRefs(db, LEAD_A, { consumer_type: 'events', consumer_id: eventFuture.id }).length, 0);
    n++;
    // Re-link for the payload + HTTP parts below.
    sm.updateEvent(db, LEAD_A, eventFuture.id, { gallery_album_id: albumA.id });
    group('Part 2c event gallery link + dormant resolution', n);
  }

  {
    let n = 0;
    // Public item payload: the event page data carries the photos.
    const emb = sm.ensureEmbed(db, LEAD_A, 'events', { workspaceId: WS_ID });
    db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(emb.id);
    const payload = sm.getPublicModuleItem(db, emb.public_token, eventFuture.slug);
    assert.ok(payload.item.shared_gallery, 'public event payload carries shared_gallery');
    assert.equal(payload.item.shared_gallery.images.length, 2);
    assert.equal(payload.item.shared_gallery.album_title, 'Shop Opening Photos');
    n += 3;
    const unlinkedPayload = sm.getPublicModuleItem(db, emb.public_token, eventPast.slug);
    assert.ok(
      !('shared_gallery' in unlinkedPayload.item) || !unlinkedPayload.item.shared_gallery,
      'event without a published album link carries no gallery'
    );
    n++;
    group('Part 2d public payload shared_gallery', n);
  }

  {
    let n = 0;
    // Agent tool surface through the real MCP dispatch.
    const mcp = require(path.join(root, 'server/mcp.js'));
    const sources = await mcp.callTool(WS_ID, 'shared.sources', { leadId: LEAD_A }, {});
    assert.equal(sources.ok, true, 'shared.sources dispatches');
    assert.equal(sources.data.sources.length, sm.MODULE_TYPES.length);
    n += 2;
    const items = await mcp.callTool(WS_ID, 'shared.items', { leadId: LEAD_A, source: 'offers' }, {});
    assert.equal(items.ok, true);
    assert.equal(items.data.items.length, 1);
    assert.equal(items.data.items[0].title, 'Spring Cut Special');
    n += 3;
    const linked = await mcp.callTool(
      WS_ID,
      'shared.link',
      {
        leadId: LEAD_A,
        consumer_type: 'events',
        consumer_id: eventPast.id,
        provider_type: 'gallery',
        provider_id: albumA.id,
        role: 'album',
      },
      {}
    );
    assert.equal(linked.ok, true, 'shared.link dispatches');
    assert.equal(Number(linked.data.ref.provider_id), albumA.id);
    n += 2;
    const resolved = share.resolveEventGallery(db, LEAD_A, sm.getEvent(db, LEAD_A, eventPast.id));
    assert.ok(resolved && resolved.images.length === 2, 'agent-placed link resolves on the event');
    n++;
    const unlinked = await mcp.callTool(
      WS_ID,
      'shared.unlink',
      { leadId: LEAD_A, consumer_type: 'events', consumer_id: eventPast.id, provider_type: 'gallery', role: 'album' },
      {}
    );
    assert.equal(unlinked.ok, true);
    assert.equal(unlinked.data.cleared, true);
    n += 2;
    // And the same composition through events.update (agent's other path).
    const upd = await mcp.callTool(
      WS_ID,
      'events.update',
      { leadId: LEAD_A, id: eventPast.id, gallery_album_id: albumA.id },
      {}
    );
    assert.equal(upd.ok, true, 'events.update dispatches with gallery_album_id');
    assert.equal(Number(upd.data.event.gallery_album_id), albumA.id);
    n += 2;
    await mcp.callTool(WS_ID, 'events.update', { leadId: LEAD_A, id: eventPast.id, gallery_album_id: 0 }, {});
    group('Part 2e agent tools via MCP dispatch', n);
  }

  {
    let n = 0;
    // Newsletter blocks: resolved at preview, frozen into the send.
    nl.saveConfig(db, LEAD_A, { heading: 'Alpha Letter', from_name: 'Alpha Cuts', from_email: '' });
    nl.addSubscriber(db, LEAD_A, { email: 'sub122@example.invalid', name: 'Sub One' });
    const sent = [];
    const deps = {
      settings: {
        'mail.provider': 'cloudflare',
        'smtp.from_email': 'hello@bitpype.test',
        'smtp.from_name': 'BitPype',
        'smtp.host': '',
      },
      sendMail: async (m) => {
        sent.push(m);
        return { sent: true };
      },
    };
    const blocks = [
      { source: 'socialfeed', limit: 5 },
      { source: 'events', limit: 5 },
      { source: 'offers', limit: 5 },
      { source: 'video', limit: 5 },
    ];
    const pv = await nl.previewIssue(
      WS_ID,
      LEAD_A,
      { subject: 'Alpha Update', bodyHtml: '<p>Hello {{name}}</p>', blocks },
      deps
    );
    const rep = Object.fromEntries((pv.blocks || []).map((b) => [b.source, b]));
    assert.equal(rep.socialfeed.included, true, 'social block included');
    assert.equal(rep.socialfeed.count, 1);
    assert.equal(rep.events.included, true, 'events block included');
    assert.equal(rep.events.count, 2, 'events block is upcoming-only (future + Part 2c event; past event filtered)');
    assert.equal(rep.offers.included, true, 'offers block included');
    assert.equal(rep.offers.count, 1);
    assert.equal(rep.video.included, false, 'empty source block left out');
    assert.ok(rep.video.note.includes('left out'), 'empty source explains itself in the composer');
    n += 8;
    assert.ok(pv.rendered.html.includes('Fresh cut Friday'), 'preview shows the social post');
    assert.ok(pv.rendered.html.includes('Grand Opening Day'), 'preview shows the upcoming event');
    assert.ok(!pv.rendered.html.includes('Last Month Meetup'), 'preview omits the past event from the block');
    assert.ok(pv.rendered.html.includes('Spring Cut Special'), 'preview shows the live offer');
    n += 4;

    // The source changes AFTER the preview — the send must not move.
    sm.createOffer(db, LEAD_A, { title: 'Late Breaking Offer', status: 'published', expires_at: ymd(30) });
    await assert.rejects(
      () =>
        nl.sendIssue(
          WS_ID,
          LEAD_A,
          {
            subject: 'Alpha Update',
            bodyHtml: '<p>Hello {{name}}</p>',
            previewToken: pv.previewToken,
            confirmCount: 1,
          },
          deps
        ),
      (e) => e.code === 'PREVIEW_REQUIRED',
      'send that drops the previewed blocks is refused'
    );
    n++;
    const out = await nl.sendIssue(
      WS_ID,
      LEAD_A,
      {
        subject: 'Alpha Update',
        bodyHtml: '<p>Hello {{name}}</p>',
        blocks,
        previewToken: pv.previewToken,
        confirmCount: 1,
      },
      deps
    );
    assert.equal(out.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].html, pv.rendered.html, 'sent HTML is byte-identical to the preview (frozen)');
    assert.ok(!sent[0].html.includes('Late Breaking Offer'), 'post-preview source change did not leak into the send');
    n += 4;

    // Reverse mismatch: preview without blocks, send with blocks.
    const pv2 = await nl.previewIssue(WS_ID, LEAD_A, { subject: 'Plain', bodyHtml: '<p>Plain</p>' }, deps);
    await assert.rejects(
      () =>
        nl.sendIssue(
          WS_ID,
          LEAD_A,
          { subject: 'Plain', bodyHtml: '<p>Plain</p>', blocks, previewToken: pv2.previewToken, confirmCount: 1 },
          deps
        ),
      (e) => e.code === 'PREVIEW_REQUIRED',
      'send that adds blocks after a plain preview is refused'
    );
    n++;
    group('Part 2f newsletter blocks frozen into the send', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner122@example.invalid',
      h: bcrypt.hashSync('UnusedPass122!', 12),
      n: 'B122 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner122@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B122 Alpha Cuts' }
    );
    const platform = require(path.join(root, 'server/platform.js'));
    await platform.setPlatformSetting('mail.provider', 'cloudflare');
    await platform.setPlatformSetting('mail.cf_token', 'fixture-token');
    await platform.setPlatformSetting('mail.cf_account_id', 'fixture-account');
    await platform.setPlatformSetting('smtp.from_email', 'hello@bitpype.test');
    await platform.setPlatformSetting('smtp.from_name', 'BitPype');

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
      const owner = makeJar();
      {
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner122@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }

      // Anonymous refused.
      {
        const res = await fetch(`${BASE}/api/v1/portal/modules/shared/sources`);
        assert.equal(res.status, 401, 'anonymous shared sources refused');
        n++;
      }
      // Sources endpoint: full registry, live counts.
      let eventsToken = '';
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/shared/sources`);
        assert.equal(res.status, 200, 'shared sources over HTTP');
        const data = await json(res);
        const sources = (data.data || data).sources || data.sources;
        assert.equal(sources.length, sm.MODULE_TYPES.length, 'all module types listed');
        const gallery = sources.find((s) => s.type === 'gallery');
        assert.equal(gallery.kind, 'provider');
        assert.ok(gallery.count >= 2, 'gallery counts the fixture albums');
        n += 4;
      }
      // Items endpoint: the picker feed.
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/shared/items?source=gallery&limit=100`);
        assert.equal(res.status, 200);
        const data = await json(res);
        const items = (data.data || data).items || data.items;
        assert.ok(
          items.some((i) => i.title === 'Shop Opening Photos'),
          'picker feed carries the album'
        );
        n += 2;
      }
      // Link through the generic module route (the editor's save path).
      {
        const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
        const res = await put(owner, `/api/v1/portal/modules/events/${eventPast.id}`, { gallery_album_id: albumA.id });
        assert.equal(res.status, 200, 'editor-path event update');
        const data = await json(res);
        const item = (data.data || data).item || data.data || data;
        assert.equal(Number(item.gallery_album_id), albumA.id, 'editor path persisted the link');
        n += 2;
        const list = await owner.fetch(`${BASE}/api/v1/portal/modules/events`);
        const listData = await json(list);
        const rows = (listData.data || listData).items || [];
        const row = rows.find((r) => Number(r.id) === Number(eventPast.id));
        assert.ok(row && Number(row.gallery_album_id) === albumA.id, 'event list carries the link for the editor');
        n++;
      }
      // Public payload: the event page data serves the gallery.
      {
        const embRow = db
          .prepare("SELECT public_token FROM site_module_embeds WHERE lead_id = ? AND module_type = 'events'")
          .get(LEAD_A);
        eventsToken = embRow.public_token;
        const res = await fetch(
          `${BASE}/api/v1/modules/public/${eventsToken}?slug=${encodeURIComponent(eventPast.slug)}`
        );
        assert.equal(res.status, 200, 'public event payload');
        const data = await json(res);
        const item = (data.data || data).item;
        assert.ok(item.shared_gallery, 'public event serves shared_gallery after the HTTP link');
        assert.equal(item.shared_gallery.images.length, 2);
        n += 3;
      }
      // Newsletter preview over HTTP reports its blocks.
      {
        const res = await post(owner, '/api/v1/portal/modules/newsletter/preview', {
          subject: 'HTTP Issue',
          bodyHtml: '<p>Hi there</p>',
          blocks: [
            { source: 'socialfeed', limit: 5 },
            { source: 'video', limit: 5 },
          ],
        });
        assert.equal(res.status, 200, 'newsletter preview over HTTP');
        const data = await json(res);
        const payload = data.data || data;
        const rep = Object.fromEntries((payload.blocks || []).map((b) => [b.source, b]));
        assert.equal(rep.socialfeed.included, true, 'HTTP preview includes the social block');
        assert.equal(rep.video.included, false, 'HTTP preview reports the empty video block');
        assert.ok(payload.rendered.html.includes('Fresh cut Friday'), 'HTTP preview renders the post');
        n += 4;
      }
      group('Part 3 HTTP portal + public flow', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH122 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH122 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
