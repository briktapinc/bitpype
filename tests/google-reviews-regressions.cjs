'use strict';
/**
 * Batch 30 — Google Reviews module.
 *   catalog + portalTabs registration (owner gets it, renter does not)
 *   → platform setting registration (secret, validated, never seeded
 *   into workspaces) → MCP catalog/parity presence → Place ID config
 *   validation + clamps → mocked Places fetch (headers, URL, parse,
 *   cache) → TTL/stale + failure-keeps-cache → dormant refresh codes
 *   (NO_KEY / NO_PLACE_ID) → min-rating filter → public payload
 *   (populated vs dormant) → module-embed.js render (populated shows
 *   rating + reviews + Google attribution; dormant renders nothing)
 *   → portal preview states. NO live Google calls: every fetch is a
 *   mock injected via opts.fetchImpl.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const db = new Database(':memory:');
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module,
    exports: module.exports,
    require: (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    },
    process: { env: {} },
    console,
    Buffer,
    URL,
    Date,
    setTimeout,
    clearTimeout,
  }, { filename: file });
  return module.exports;
}

const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const PLACES_JSON = {
  displayName: { text: 'Fixture Plumbing' },
  rating: 4.7,
  userRatingCount: 132,
  googleMapsUri: 'https://maps.google.com/?cid=123456',
  reviews: [
    { rating: 5, text: { text: 'Fixed our burst pipe the same day. Brilliant.' }, relativePublishTimeDescription: '2 days ago', publishTime: '2026-10-25T10:00:00Z', authorAttribution: { displayName: 'Alice A', uri: 'https://www.google.com/maps/contrib/111', photoUri: 'https://lh3.googleusercontent.com/a/alice' } },
    { rating: 4, text: { text: 'Good work, fair price.' }, relativePublishTimeDescription: 'a week ago', publishTime: '2026-10-20T10:00:00Z', authorAttribution: { displayName: 'Bob B', uri: '', photoUri: '' } },
    { rating: 5, text: { text: 'Third time using them — never disappointed.' }, relativePublishTimeDescription: '2 weeks ago', publishTime: '2026-10-13T10:00:00Z', authorAttribution: { displayName: 'Carol C', uri: '', photoUri: '' } },
    { rating: 3, text: { text: 'Okay, but they arrived late.' }, relativePublishTimeDescription: 'a month ago', publishTime: '2026-09-27T10:00:00Z', authorAttribution: { displayName: 'Dan D', uri: '', photoUri: '' } },
    { rating: 5, text: { text: 'Highly recommended to all my neighbours.' }, relativePublishTimeDescription: 'a month ago', publishTime: '2026-09-26T10:00:00Z', authorAttribution: { displayName: 'Erin E', uri: '', photoUri: '' } },
  ],
};

async function main() {
  const sm = load('server/siteModules.js', {
    '../src/pageContentScan': require(path.join(root, 'src/pageContentScan.js')),
    // Batch 149: siteModules' managed-script ensures delegate to the
    // shared canonical helper (same mock-map extension pattern as
    // Batch 145's stripeShapes fix in account-link-regressions).
    '../src/managedScripts': require(path.join(root, 'src/managedScripts.js')),
    // Batch 154: siteModules' mutating Stripe calls carry deterministic
    // idempotency keys via the shared helper (same mock-map extension
    // pattern as the Batch 149 managedScripts entry above).
    './stripeIdempotency': require(path.join(root, 'server/stripeIdempotency.js')),
  });
  sm.ensureTables(db);

  // ── Catalog + portalTabs registration ──
  check('batch30 catalog: googlereviews is the 20th module type with meta', () => {
    assert.equal(sm.MODULE_TYPES.length, 32); // Batch 124: categories the 24th type; Batch 125: photocapture the 25th; Batch 128: checkout the 27th; Batch 131: comments the 28th; Batch 139: pricing the 29th; Batch 164: custom_code the 30th
    assert.equal(sm.MODULE_TYPES[19], 'googlereviews');
    assert.equal(sm.MODULE_META.googlereviews.label, 'Google Reviews');
    assert.equal(sm.MODULE_META.googlereviews.defaultSlug, 'reviews');
  });
  const tabs = require(path.join(root, 'server/portalTabs.js'));
  check('batch30 portalTabs: owner includes googlereviews, renter stays calltracking-only', () => {
    assert(tabs.PORTAL_MODULES.includes('googlereviews'));
    assert(tabs.effectiveModules('owner', null).includes('googlereviews'));
    assert.deepEqual(tabs.effectiveModules('renter', null), ['calltracking']);
    assert(tabs.effectiveModules('renter', { googlereviews: true }).includes('googlereviews'), 'admin override can grant it');
  });

  // ── Platform setting registration ──
  const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
  check('batch30 settings: google.places_api_key is a validated secret, excluded from workspace seeds', () => {
    assert(settingsKeys.SECRET_KEYS.includes('google.places_api_key'));
    const okRes = settingsKeys.validateSetting('google.places_api_key', 'AIzaSyD-example-key-123');
    assert.equal(okRes.ok, true);
    assert.equal(settingsKeys.validateSetting('google.places_api_key', 'bad\0key').ok, false);
    assert.equal(settingsKeys.validateSetting('google.places_api_key', 'x'.repeat(501)).ok, false);
    const platformSrc = fs.readFileSync(path.join(root, 'server/platform.js'), 'utf8');
    assert(platformSrc.includes("key: 'google.places_api_key'"), 'platform def exists');
    assert(platformSrc.includes("'google.places_api_key',\n      ].includes(k)"), 'excluded from WORKSPACE_SEED_KEYS');
    const defsRegion = platformSrc.slice(platformSrc.indexOf('PLATFORM_SETTING_DEFS'));
    assert(defsRegion.includes("label: 'Google Places API key (Reviews module)', default: '', secret: true"), 'def is secret:true');
  });

  // ── MCP presence: catalog + parity handlers (Batch 28 failure mode) ──
  check('batch30 MCP: all four googlereviews tools in catalog AND parity handlers', () => {
    const catalog = require(path.join(root, 'src/mcpCatalog.js'));
    const catalogNames = new Set((catalog.tools || []).map((t) => t.name));
    const parityNames = new Set(require(path.join(root, 'src/mcpParityTools.js')).getParityCatalogEntries().map((t) => t.name));
    for (const n of ['googlereviews.getConfig', 'googlereviews.updateConfig', 'googlereviews.preview', 'googlereviews.refresh']) {
      assert(catalogNames.has(n), 'catalog has ' + n);
      assert(parityNames.has(n), 'parity handler exists for ' + n);
    }
    const hostedSrc = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
    for (const n of ['googlereviews.getConfig', 'googlereviews.updateConfig', 'googlereviews.preview', 'googlereviews.refresh']) {
      assert(hostedSrc.includes(`name === '${n}'`), 'hosted handler for ' + n);
      assert(hostedSrc.includes(`name: '${n}'`), 'hosted tool def for ' + n);
    }
    const addModule = (catalog.tools || []).find((t) => t.name === 'website.addModule');
    const enumText = JSON.stringify(addModule && addModule.schema ? addModule.schema : addModule && addModule.inputSchema ? addModule.inputSchema : {});
    assert(enumText.includes('googlereviews'), 'catalog addModule enum includes googlereviews');
  });

  // ── Config validation + clamps ──
  check('batch30 config: Place ID validated, max/min clamped, clear works', () => {
    assert.throws(() => sm.updateGoogleReviewsConfig(db, 3001, { place_id: 'not a place!!' }), (e) => e.code === 'VALIDATION');
    assert.throws(() => sm.updateGoogleReviewsConfig(db, 3001, { place_id: 'short' }), (e) => e.code === 'VALIDATION');
    const cfg = sm.updateGoogleReviewsConfig(db, 3001, { place_id: PLACE_ID, max_reviews: 99, min_rating: 7 });
    assert.equal(cfg.place_id, PLACE_ID);
    assert.equal(cfg.max_reviews, 5, 'max_reviews clamps to the Places cap of 5');
    assert.equal(cfg.min_rating, 5, 'min_rating clamps to 5');
    const cfg2 = sm.updateGoogleReviewsConfig(db, 3001, { max_reviews: 0, min_rating: 4.3 });
    assert.equal(cfg2.max_reviews, 1, 'max_reviews clamps to at least 1');
    assert.equal(cfg2.min_rating, 4.5, 'min_rating snaps to half steps');
    assert.equal(sm.updateGoogleReviewsConfig(db, 3001, { min_rating: 0 }).min_rating, 0);
    assert.equal(sm.readGoogleReviewsConfig(db, 3999).place_id, '', 'unconfigured lead reads empty');
  });

  // ── Mocked fetch: request shape, parse, cache ──
  let fetchCalls = [];
  const okFetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => PLACES_JSON };
  };
  await acheck('batch30 fetch: server-side Places call with header key + field mask, parsed into cache', async () => {
    fetchCalls = [];
    const res = await sm.refreshGoogleReviews(db, 3001, { apiKey: 'test-key-123', fetchImpl: okFetch, force: true });
    assert.equal(res.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, `https://places.googleapis.com/v1/places/${PLACE_ID}`);
    assert(!fetchCalls[0].url.includes('test-key-123'), 'key never travels in the URL');
    assert.equal(fetchCalls[0].opts.headers['X-Goog-Api-Key'], 'test-key-123');
    assert(fetchCalls[0].opts.headers['X-Goog-FieldMask'].includes('reviews'));
    assert(fetchCalls[0].opts.headers['X-Goog-FieldMask'].includes('userRatingCount'));
    const cache = sm.readGoogleReviewsCache(db, 3001);
    assert.equal(cache.data.rating, 4.7);
    assert.equal(cache.data.total, 132);
    assert.equal(cache.data.name, 'Fixture Plumbing');
    assert.equal(cache.data.reviews.length, 5);
    assert.equal(cache.data.reviews[0].author, 'Alice A');
    assert.equal(cache.data.reviews[0].relative_time, '2 days ago');
    assert(cache.fetched_at, 'fetched_at stamped');
  });

  await acheck('batch30 TTL: fresh cache skips the network; 25h-old cache is stale', async () => {
    assert.equal(sm.googleReviewsCacheStale(db, 3001), false);
    fetchCalls = [];
    const skipped = await sm.refreshGoogleReviews(db, 3001, { apiKey: 'test-key-123', fetchImpl: okFetch });
    assert.equal(skipped.skipped, 'fresh');
    assert.equal(fetchCalls.length, 0, 'no fetch while fresh');
    db.prepare("UPDATE googlereviews_cache SET fetched_at = datetime('now', '-25 hours') WHERE lead_id = 3001").run();
    assert.equal(sm.googleReviewsCacheStale(db, 3001), true);
  });

  await acheck('batch30 failure: HTTP 500 keeps last good cache + records error; 404 codes NOT_FOUND', async () => {
    const failFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom-internal' } }) });
    const res = await sm.refreshGoogleReviews(db, 3001, { apiKey: 'test-key-123', fetchImpl: failFetch, force: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'PLACES_ERROR');
    const cache = sm.readGoogleReviewsCache(db, 3001);
    assert.equal(cache.data.rating, 4.7, 'last good payload survives a failed refresh');
    assert(cache.last_error.includes('boom-internal'), 'error recorded for the portal');
    const nfFetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found' } }) });
    const nf = await sm.refreshGoogleReviews(db, 3001, { apiKey: 'test-key-123', fetchImpl: nfFetch, force: true });
    assert.equal(nf.code, 'PLACES_NOT_FOUND');
    assert.equal(sm.readGoogleReviewsCache(db, 3001).data.rating, 4.7, 'cache still intact after 404');
  });

  await acheck('batch30 dormant refresh: NO_PLACE_ID and NO_KEY never touch the network or cache', async () => {
    let calls = 0;
    const countingFetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => PLACES_JSON };
    };
    const noPlace = await sm.refreshGoogleReviews(db, 3999, { apiKey: 'k', fetchImpl: countingFetch, force: true });
    assert.equal(noPlace.code, 'NO_PLACE_ID');
    sm.updateGoogleReviewsConfig(db, 3998, { place_id: PLACE_ID });
    const noKey = await sm.refreshGoogleReviews(db, 3998, { apiKey: '', fetchImpl: countingFetch, force: true });
    assert.equal(noKey.code, 'NO_KEY');
    assert.equal(calls, 0, 'no network call in dormant states');
    assert.equal(sm.readGoogleReviewsCache(db, 3998).fetched_at, null, 'no cache written without a key');
  });

  // ── Filtering ──
  check('batch30 items: min-rating filter + max cap apply to cached reviews', () => {
    sm.updateGoogleReviewsConfig(db, 3001, { min_rating: 4, max_reviews: 2 });
    const items = sm.googleReviewsItems(db, 3001);
    assert.equal(items.length, 2);
    assert(items.every((r) => r.rating >= 4), 'all shown reviews meet the minimum');
    assert.equal(JSON.stringify(items.map((r) => r.author)), JSON.stringify(['Alice A', 'Bob B']));
    sm.updateGoogleReviewsConfig(db, 3001, { min_rating: 0, max_reviews: 5 });
    assert.equal(sm.googleReviewsItems(db, 3001).length, 5);
  });

  // ── Public payload ──
  db.exec(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
           CREATE TABLE IF NOT EXISTS websites (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER DEFAULT 1, lead_id INTEGER, name TEXT NOT NULL, industry TEXT, theme TEXT NOT NULL, pages TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', origin TEXT DEFAULT 'template', preview_path TEXT, preview_url TEXT, custom_domain TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (3001, 'Fixture Plumbing', 'gr@example.invalid')").run();
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (3002, 'Dormant Biz', 'dormant@example.invalid')").run();
  const pagesJson = JSON.stringify([{ slug: 'index', file: 'index.html', title: 'Home', nav_label: 'Home', html: '<p>hi</p>', sections: [] }]);
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (3001, ?, ?, ?)').run('Fixture Site', '{}', pagesJson);
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (3002, ?, ?, ?)').run('Dormant Site', '{}', pagesJson);
  let pubPayload;
  check('batch30 public payload: populated lead serves summary + reviews; dormant + zero-review leads serve nothing', () => {
    const emb = sm.attachModule(db, 3001, 'googlereviews', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
    pubPayload = sm.getPublicModuleByToken(db, emb.public_token);
    assert.equal(pubPayload.module_type, 'googlereviews');
    assert.equal(pubPayload.googlereviews.rating, 4.7);
    assert.equal(pubPayload.googlereviews.total, 132);
    assert.equal(pubPayload.googlereviews.google_maps_uri, 'https://maps.google.com/?cid=123456');
    assert.equal(pubPayload.items.length, 5);
    const embDormant = sm.attachModule(db, 3002, 'googlereviews', { workspaceId: 1, appUrl: 'https://example.test' }).embed;
    const dormant = sm.getPublicModuleByToken(db, embDormant.public_token);
    assert.equal(dormant.googlereviews, undefined, 'dormant payload carries no summary');
    assert.equal(dormant.items.length, 0);
    // Zero reviews from Google → also nothing (no placeholder).
    sm.updateGoogleReviewsConfig(db, 3002, { place_id: PLACE_ID });
    sm.storeGoogleReviewsCache(db, 3002, { name: 'Dormant Biz', rating: null, total: 0, google_maps_uri: '', reviews: [] });
    const zero = sm.getPublicModuleByToken(db, embDormant.public_token);
    assert.equal(zero.googlereviews, undefined);
    assert.equal(zero.items.length, 0);
    assert.equal(sm.moduleItemCount(db, 3001, 'googlereviews'), 5, 'badge counts shown reviews');
  });

  // ── Render via module-embed.js under a fake DOM ──
  const embedSrc = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
  function fakeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      parentElement: null,
      previousElementSibling: null,
      _html: '',
      _text: '',
      _attrs: {},
      _classes: new Set(),
      style: {},
      classList: {
        add: (...cs) => cs.forEach((c) => el._classes.add(c)),
        remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
        contains: (c) => el._classes.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !el._classes.has(c) : !!force;
          if (on) el._classes.add(c);
          else el._classes.delete(c);
          return on;
        },
      },
      getAttribute: (n) => (n in el._attrs ? el._attrs[n] : null),
      setAttribute: (n, v) => {
        el._attrs[n] = String(v);
      },
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      appendChild: (child) => {
        el.children.push(child);
        return child;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: (v) => {
        el._html = String(v);
      },
    });
    Object.defineProperty(el, 'textContent', {
      get: () => el._text,
      set: (v) => {
        el._text = String(v);
      },
    });
    return el;
  }
  async function renderModule(payload) {
    const mount = fakeEl('div');
    mount.setAttribute('data-bitpype-module', '1');
    mount.setAttribute('data-bitpype-module-token', payload.embed.public_token);
    mount.setAttribute('data-bitpype-api', 'https://example.test');
    mount.setAttribute('data-bitpype-hide-title', '1');
    const body = fakeEl('body');
    body.children = [fakeEl('header'), fakeEl('main'), mount];
    mount.parentElement = body;
    let css = '';
    const documentStub = {
      readyState: 'complete',
      body,
      head: {
        appendChild: (s) => {
          css = s.textContent || '';
          return s;
        },
      },
      getElementById: () => null,
      createElement: (tag) => fakeEl(tag),
      querySelector: () => null,
      querySelectorAll: (sel) => (sel.includes('data-bitpype-module') && !sel.includes('member-gate') ? [mount] : []),
      addEventListener: () => {},
    };
    const locationStub = { pathname: '/index.html', search: '', href: 'https://example.test/index.html' };
    vm.runInNewContext(embedSrc, {
      window: { location: locationStub },
      document: documentStub,
      localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: locationStub,
      fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: payload }) }),
      URL,
      URLSearchParams,
      console,
      setTimeout,
      clearTimeout,
    });
    await new Promise((r) => setTimeout(r, 25));
    return { html: mount._html, css };
  }
  await acheck('batch30 render: summary, cards, attribution render; dormant payload renders empty; CSS ships padded cards', async () => {
    const rendered = await renderModule(pubPayload);
    assert(rendered.html.includes('bp-mod-googlereviews'), 'wrapper renders');
    assert(rendered.html.includes('4.7'), 'average rating shows');
    assert(rendered.html.includes('132'), 'total count shows');
    assert(rendered.html.includes('Alice A'), 'author attribution shows');
    assert(rendered.html.includes('Fixed our burst pipe'), 'review text shows unaltered');
    assert(rendered.html.includes('★'), 'stars render');
    assert(rendered.html.includes('Reviews powered by'), 'Google credit line renders');
    assert(rendered.html.includes('https://maps.google.com/?cid=123456'), 'listing link renders');
    assert(rendered.css.includes('.bp-mod-googlereviews'), 'module CSS ships');
    assert(rendered.css.includes('.bp-mod-gr-card{'), 'card CSS ships');
    assert(rendered.css.includes('padding:1.1rem 1.2rem'), 'cards carry generous padding');
    const dormantPayload = { ...pubPayload, googlereviews: undefined, items: [] };
    const dormant = await renderModule(dormantPayload);
    assert.equal(dormant.html, '', 'dormant payload renders literally nothing');
  });

  // ── Portal preview states ──
  await acheck('batch30 preview: no_key / no_place_id / never_fetched / ready states in plain words', async () => {
    const noKey = await sm.googleReviewsPreview(db, 3001, { apiKey: '' });
    assert.equal(noKey.state, 'no_key');
    assert.equal(noKey.key_configured, false);
    assert(noKey.message.includes('Admin'), 'no-key message points at Admin settings');
    const noPlace = await sm.googleReviewsPreview(db, 3999, { apiKey: 'k' });
    assert.equal(noPlace.state, 'no_place_id');
    sm.updateGoogleReviewsConfig(db, 3997, { place_id: PLACE_ID });
    const never = await sm.googleReviewsPreview(db, 3997, { apiKey: 'k' });
    assert.equal(never.state, 'never_fetched');
    const ready = await sm.googleReviewsPreview(db, 3001, { apiKey: 'k' });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.summary.rating, 4.7);
    assert.equal(ready.summary.total, 132);
    assert.equal(ready.summary.review_count, 5);
    assert.equal(ready.key_configured, true);
  });

  console.log(JSON.stringify({ file: 'google-reviews-regressions', checks: results.length, passed: true }));
  for (const r of results) console.log('  ✓ ' + r);
}

main().catch((e) => {
  console.error('google-reviews-regressions FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
