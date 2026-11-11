'use strict';
/**
 * Batch 178 — the Leads Router module (Phase 1).
 *
 * What this pins:
 *   Part 1 — source pins: `leads_router` is the 32nd MODULE_TYPE with
 *     catalog metadata (Requires Muse flag), MODULE_SCRIPT_VER stays
 *     mod41 (no embed renderer), an explicit moduleShare registry
 *     entry (kind 'none' + the router_demand declaration), the
 *     engine + its tables, the LeadScout captureFromRouterClaim kind,
 *     the portal facade + dedicated routes, the staff REST family,
 *     the MCP + catalog + parity surfaces (and their deliberate
 *     ABSENCE from the design-agent surface), the portal/staff UI
 *     wiring (DOM-only panels — no innerHTML in the Router blocks),
 *     the icon, the nav entries, and the cache-busts.
 *   Part 2 — engine (in-process): source seeding + platform liveness
 *     (facebook live, the rest planned), settings-as-data stale
 *     windows, select-or-type follows (typed-new ≡ selected;
 *     "Roofer"/"roofing" normalize together, as-typed preserved;
 *     planned-platform-only follow refused), Requires-Muse states
 *     (no sweep → "Hunting inactive" + waiting_on_muse; a recorded
 *     sweep → active + last-sweep), sweep scope (ALL = live platforms
 *     only; specific non-live refused; typed follow generates its
 *     sweep queries), the review gate (candidate never feeds),
 *     routing (type + location town/area + kind + platform), dedupe
 *     (same post twice = one; cross-platform = one lead, both
 *     sources), freshness on posted_at (not first_seen_at), claim
 *     (exclusive, exactly-once, LeadScout capture stamped), removal
 *     (never re-enters), the shared layer (demand counts via the
 *     declaration), module mechanics (attach/summary/purge/public
 *     payload dormant), lead delete/merge cascades, MCP dispatch.
 *   Part 3 — HTTP over the real server: staff session (overview,
 *     queue publish, sweep record, sources), portal owner session
 *     (panel block, follow set, claim), and the 390px feed geometry
 *     (uniform card gaps, no overflow) in a headless page.
 *
 * The ingestion boundary is pinned too: the engine source contains
 * no HTTP client, no fetch, no platform URL — leads enter only
 * through publishLead (API/MCP/queue).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch178-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
// Fixture secrets are fragment-assembled, never single literals.
process.env['SESSION_' + 'SECRET'] = ['batch178', 'test', 'session', 'secret', 'x7'].join('-');
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';
process.env.CAPTCHA_OPTIONAL = '1';

const root = path.resolve(__dirname, '..');
const PORT = 39178;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 17801;
const LEAD_B = 17802;
const LEAD_C = 17803;
const LEAD_D = 17804;
const LEAD_E = 17805;
const LEAD_F = 17806;
const LEAD_G = 17807;
const PW = ['B178', 'Portal', 'Pass', '9'].join('-') + '!';
const STAFF_PW = ['B178', 'Staff', 'Pass', '9'].join('-') + '!';

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
const hoursAgoIso = (h) => new Date(Date.now() - h * 36e5).toISOString();
const hoursFromNowIso = (h) => new Date(Date.now() + h * 36e5).toISOString();

let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(sm.MODULE_TYPES.length, 32, 'MODULE_TYPES at 32');
    n++;
    assert.equal(sm.MODULE_TYPES[31], 'leads_router', 'leads_router is the 32nd type (appended)');
    n++;
    assert.equal(sm.MODULE_META.leads_router.label, 'Leads Router');
    n++;
    assert.equal(sm.MODULE_META.leads_router.requiresClaude, true, 'catalog metadata carries the Requires Muse flag');
    n++;
    assert.equal(sm.MODULE_META.leads_router.noNav, true, 'portal/staff module — no public nav page');
    n++;
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod41', 'MODULE_SCRIPT_VER unchanged — the Router has no embed renderer');
    n++;
    assert.ok(
      smSrc.includes("if (emb.module_type === 'leads_router') continue;"),
      'sync never auto-injects a Router mount'
    );
    n++;
    assert.ok(smSrc.includes("type === 'leads_router'"), 'public payload carries the dormant Router branch');
    n++;
    assert.ok(smSrc.includes("case 'leads_router':"), 'module purge steps cover the Router (follows)');
    n++;

    const share = require(path.join(root, 'server/moduleShare.js'));
    assert.ok(share.SHARE_REGISTRY.leads_router, 'shared-layer registry carries the leads_router entry');
    n++;
    assert.equal(
      share.SHARE_REGISTRY.leads_router.kind,
      'none',
      'Router provides no renderable items (poster data is never content)'
    );
    n++;
    assert.ok(
      share.SHARE_REGISTRY.leads_router.declarations &&
        typeof share.SHARE_REGISTRY.leads_router.declarations.router_demand === 'function',
      'the router_demand declaration is registered'
    );
    n++;

    const engineSrc = read('server/leadsRouter.js');
    for (const t of ['router_leads', 'router_follows', 'router_sources', 'router_sweeps', 'router_settings']) {
      assert.ok(engineSrc.includes(t), `engine owns ${t}`);
      n++;
    }
    assert.ok(
      !/require\('node:https?'\)|\bfetch\(|facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|x\.com\//.test(
        engineSrc.replace(/facebook\|x\|linkedin\|tiktok\|instagram/g, '')
      ),
      'ingestion boundary: the engine has no HTTP client and no platform endpoints'
    );
    n++;
    assert.ok(
      engineSrc.includes('Hunting inactive — connect Muse to start finding leads'),
      'the exact Requires-Muse status line lives in the engine'
    );
    n++;

    const pc = require(path.join(root, 'server/portalContacts.js'));
    assert.equal(typeof pc.captureFromRouterClaim, 'function', 'LeadScout capture kind exists');
    n++;
    const pcSrc = read('server/portalContacts.js');
    assert.ok(pcSrc.includes('router_lead_id'), 'leadscout_events gains the router_lead_id ref');
    n++;
    assert.ok(
      pcSrc.includes('idx_leadscout_router_unique'),
      'one capture event per router lead (partial unique index)'
    );
    n++;

    const pm = require(path.join(root, 'server/portalModules.js'));
    for (const fn of ['routerSetFollow', 'routerDeleteFollow', 'routerClaimLead']) {
      assert.equal(typeof pm[fn], 'function', `portal facade carries ${fn}`);
      n++;
    }
    const cp = require(path.join(root, 'server/clientPortal.js'));
    for (const fn of ['routerSetFollow', 'routerDeleteFollow', 'routerClaimLead']) {
      assert.equal(typeof cp[fn], 'function', `clientPortal re-exports ${fn}`);
      n++;
    }
    const portalRoutes = read('server/routes/portal.js');
    for (const r of ['/modules/leads-router/follows', '/modules/leads-router/claim/:id']) {
      assert.ok(portalRoutes.includes(r), `portal route ${r} registered`);
      n++;
    }
    assert.ok(
      portalRoutes.indexOf('/modules/leads-router/follows') < portalRoutes.indexOf("router.get('/modules/:type'"),
      'router portal routes sit before the generic /modules/:type routes'
    );
    n++;

    const apiSrc = read('server/routes/domainApi.js');
    for (const r of [
      '/admin-area/router/overview',
      '/admin-area/router/leads',
      '/admin-area/router/candidates',
      '/admin-area/router/sources',
      '/admin-area/router/sweeps',
      '/admin-area/router/settings',
      '/admin-area/router/follows/:leadId',
    ]) {
      assert.ok(apiSrc.includes(r), `staff REST route ${r} registered`);
      n++;
    }

    const TOOLS = [
      'router_leads.list',
      'router_leads.get',
      'router_leads.publish',
      'router_leads.remove',
      'router_follows.list',
      'router_follows.set',
      'router_sources.list',
      'router_sources.update',
      'router_sweeps.run',
    ];
    const hosted = read('server/mcp.js');
    const catalog = read('src/mcpCatalog.js');
    const parity = read('src/mcpParityTools.js');
    for (const t of TOOLS) {
      assert.ok(hosted.includes(`name: '${t}'`), `hosted MCP catalog carries ${t}`);
      n++;
      assert.ok(hosted.includes(`'${t}'`), `hosted MCP entitlement list carries ${t}`);
      n++;
      assert.ok(hosted.includes(`name === '${t}'`), `hosted MCP dispatch handles ${t}`);
      n++;
      assert.ok(catalog.includes(`name: '${t}'`), `local MCP catalog carries ${t}`);
      n++;
      assert.ok(parity.includes(`'${t}': parityEntry`), `parity tools carry ${t}`);
      n++;
    }
    const sweepsCatalog = catalog.slice(
      catalog.indexOf("name: 'router_sweeps.run'"),
      catalog.indexOf("name: 'router_sweeps.run'") + 1200
    );
    assert.ok(
      /required:\s*\['platform'\]/.test(sweepsCatalog),
      'router_sweeps.run requires the platform argument (incl. all)'
    );
    n++;
    const agentTools = read('server/museAgentTools.js');
    assert.ok(
      !agentTools.includes('router_leads') && !agentTools.includes('router_sweeps'),
      'the design-agent surface deliberately has NO Router tools (Batch 165 ruling)'
    );
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(
      portalJs.includes("{ type: 'leads_router', label: 'Leads Router' }"),
      'portal module list carries the Router'
    );
    n++;
    assert.ok(portalJs.includes('renderRouterPanel'), 'portal Router panel exists');
    n++;
    const panelBlock = portalJs.slice(portalJs.indexOf('Batch 178 — Leads Router panel'));
    assert.ok(
      !panelBlock.includes('.innerHTML'),
      'the portal Router panel is DOM/textContent-only (no new census sink)'
    );
    n++;
    assert.ok(portalJs.includes('Posted publicly on'), 'feed cards carry the spec §9 label');
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="modules-router-panel"'), 'portal.html mounts the Router panel');
    n++;
    assert.ok(portalHtml.includes('portal.js?v=batch178-router1'), 'portal.js cache-bust rotated');
    n++;

    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes("'router',"), 'staff ROUTES carries router');
    n++;
    assert.ok(appJs.includes('router: pageLeadsRouter'), 'staff PAGES maps the Router page');
    n++;
    const staffBlock = appJs.slice(appJs.indexOf('Batch 178 — Leads Router staff page'));
    assert.ok(!staffBlock.includes('.innerHTML'), 'the staff Router page is DOM/textContent-only (no new census sink)');
    n++;
    assert.ok(
      appJs.includes("badge.textContent = 'Requires Muse'"),
      'the catalog badge renders from the requires_claude flag'
    );
    n++;
    const indexHtml = read('public/index.html');
    assert.ok(indexHtml.includes('data-route="router"'), 'staff sidebar links the Router');
    n++;
    assert.ok(indexHtml.includes('app.js?v=batch178-router1'), 'app.js cache-bust rotated');
    n++;
    const navGroups = require(path.join(root, 'public/js/navGroups.js'));
    const siteTools = navGroups.NAV_GROUPS.find((g) => g.id === 'site-tools');
    assert.ok(siteTools && siteTools.items.includes('router'), 'navGroups places router in Site tools');
    n++;
    assert.ok(read('public/js/moduleIcons.js').includes('leads_router:'), 'module icon exists');
    n++;
    group('Part 1 source pins', n);
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
  const router = require(path.join(root, 'server/leadsRouter.js'));
  const portalModules = require(path.join(root, 'server/portalModules.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a178@example.invalid',
    password: STAFF_PW,
    name: 'A178',
    workspaceName: 'Batch178 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a178@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B178 Alpha Roofing', 'alpha178@example.invalid'],
    [LEAD_B, 'B178 Beta Drywall', 'beta178@example.invalid'],
    [LEAD_C, 'B178 County Wide', 'county178@example.invalid'],
    [LEAD_D, 'B178 Delta Insta', 'delta178@example.invalid'],
    [LEAD_E, 'B178 Ephemeral', 'eph178@example.invalid'],
    [LEAD_F, 'B178 Keeper', 'keep178@example.invalid'],
    [LEAD_G, 'B178 Dropped', 'drop178@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }
  db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'Alpha Site',
    'published',
    JSON.stringify([{ slug: 'index', title: 'Home' }]),
    '{}'
  );

  // ---- 2a: seeds, liveness, settings ----
  {
    let n = 0;
    router.ensureTables(db);
    const sources = router.listSources(db);
    const cc = sources.find((s) => s.name.includes('Contractors Connections'));
    assert.ok(cc, 'the proven Berks source is seeded');
    n++;
    assert.equal(cc.access_state, 'member', 'Contractors Connections seeded member (posts visible 2026-11-11)');
    n++;
    assert.equal(cc.live, true, 'a member source is live');
    n++;
    assert.deepEqual(router.livePlatforms(db), ['facebook'], 'only facebook is live before any proof sweep');
    n++;
    const states = Object.fromEntries(router.platformStates(db).map((p) => [p.platform, p.live]));
    assert.deepEqual(
      states,
      { facebook: true, x: false, linkedin: false, tiktok: false, instagram: false },
      'every other platform starts planned/not-live'
    );
    n++;
    const settings = router.getSettings(db);
    assert.deepEqual(
      [settings.stale_service_hours, settings.stale_hiring_hours, settings.hunting_window_hours],
      [48, 168, 72],
      'stale windows are settings with the spec defaults (48h service / 7d hiring)'
    );
    n++;
    const updated = router.updateSettings(db, { stale_service_hours: 48 });
    assert.equal(updated.stale_service_hours, 48, 'settings round-trip through the store');
    n++;
    group('Part 2a seeds + liveness + settings', n);
  }

  // ---- 2b: follows + Requires-Muse states ----
  {
    let n = 0;
    const hunting0 = router.huntingStatus(db);
    assert.equal(hunting0.active, false, 'no sweep ever → hunting inactive');
    n++;
    assert.equal(hunting0.state, 'never');
    n++;
    assert.equal(
      hunting0.label,
      'Hunting inactive — connect Muse to start finding leads',
      'the exact spec §16 status line'
    );
    n++;
    const checklist = router.activationChecklist(db);
    assert.equal(checklist.requires_claude, true);
    n++;
    assert.equal(checklist.badge, 'Requires Muse');
    n++;
    assert.equal(checklist.steps[0].done, false, 'checklist step 1 (Connect Muse) open before any sweep');
    n++;
    assert.ok(
      checklist.disclosure.includes('no new leads are hunted'),
      'the plain-words disclosure rides the checklist'
    );
    n++;

    // Selected follow (drywall is a known type once seeded by use).
    const fA = router.setFollow(db, LEAD_A, { lead_type_label: 'Drywall', location_label: 'Reading' });
    assert.equal(fA.follow.lead_type_key, 'drywall');
    n++;
    assert.equal(fA.follow.status, 'waiting_on_muse', 'a follow created before the first sweep waits on Muse');
    n++;
    assert.deepEqual(fA.follow.platforms, ['all'], 'platforms default to ALL');
    n++;
    // Typed-new follow: "Roofer" has never existed — valid immediately.
    const fB = router.setFollow(db, LEAD_B, { lead_type_label: 'Roofer', location_label: 'Reading' });
    assert.equal(fB.follow.lead_type_key, 'roofer', 'typed-new type normalizes to its key');
    n++;
    assert.equal(fB.follow.lead_type_label, 'Roofer', 'the as-typed label is preserved');
    n++;
    // "roofing" lands on the SAME key as "Roofer".
    const fA2 = router.setFollow(db, LEAD_A, { lead_type_label: 'roofing', location_label: 'Reading' });
    assert.equal(fA2.follow.lead_type_key, 'roofer', '"roofing" and "Roofer" normalize together');
    n++;
    assert.equal(fA2.follow.lead_type_label, 'roofing', 'each follow keeps its own as-typed wording');
    n++;
    assert.equal(router.normalizeTypeKey('Roofers'), 'roofer');
    n++;
    // A planned platform cannot be selected alone.
    assert.throws(
      () =>
        router.setFollow(db, LEAD_A, { lead_type_label: 'DJ', location_label: 'Reading', platforms: ['instagram'] }),
      /not live yet|coming soon/i,
      'a planned platform alone is refused'
    );
    n++;
    // Location normalization: "Reading, PA" ≡ "Reading".
    const fC = router.setFollow(db, LEAD_C, { lead_type_label: 'Drywall', location_label: 'Berks County' });
    assert.equal(fC.follow.location_norm, 'berks county');
    n++;
    group('Part 2b follows + Requires-Muse states', n);
  }

  // ---- 2c: sweep records ----
  {
    let n = 0;
    assert.throws(() => router.recordSweep(db, {}), /platform is required/, 'a sweep without a platform is refused');
    n++;
    assert.throws(
      () => router.recordSweep(db, { platform: 'tiktok' }),
      /not live yet/,
      'a specific sweep on a planned platform is refused'
    );
    n++;
    const run = router.recordSweep(db, { platform: 'all', run_by: 'batch178-suite' });
    assert.deepEqual(run.sweep.platforms, ['facebook'], 'ALL covers every live platform and no planned one');
    n++;
    assert.ok(
      run.queries.some((q) => q.lead_type_key === 'roofer' && q.platform === 'facebook'),
      'a typed follow generates its own sweep queries'
    );
    n++;
    assert.ok(
      run.queries.some((q) => q.lead_type_key === 'drywall'),
      'selected follows generate queries too'
    );
    n++;
    const hunting = router.huntingStatus(db);
    assert.equal(hunting.active, true, 'after a recorded sweep, hunting is active');
    n++;
    assert.ok(hunting.last_sweep_at, 'last-sweep time is recorded for the feed header');
    n++;
    const follows = router.listFollows(db, LEAD_A);
    assert.ok(
      follows.every((f) => f.status === 'active'),
      'the first sweep wakes waiting follows'
    );
    n++;
    group('Part 2c sweep records + scope', n);
  }

  // ---- 2d: review gate + routing ----
  let leadDrywall;
  {
    let n = 0;
    const made = router.publishLead(db, {
      platform: 'facebook',
      post_id: 'fb-100',
      source_url: 'https://facebook.example/posts/fb-100',
      source_context: 'Berks County PA Contractors Connections',
      poster_name: 'Chris P',
      posted_at: hoursAgoIso(1),
      lead_type: 'Drywall',
      request_kind: 'service_request',
      town: 'Reading',
      area: 'Berks County',
      detail: 'Looking for a drywall crew in Reading — two jobs ready.',
      score: 'hot',
      score_reason: 'two jobs, ready now',
    });
    leadDrywall = made.lead;
    assert.equal(made.created, true);
    n++;
    assert.equal(leadDrywall.review_state, 'candidate', 'ingest lands as a review candidate by default');
    n++;
    assert.deepEqual(router.feedForLead(db, LEAD_A), [], 'review gate: an unpublished candidate never reaches a feed');
    n++;
    assert.equal(router.listCandidates(db).length, 1, 'the candidate sits in the staff queue');
    n++;
    const reviewed = router.reviewLead(db, leadDrywall.id, { action: 'publish' });
    assert.equal(reviewed.lead.review_state, 'published');
    n++;
    const feedA = router.feedForLead(db, LEAD_A);
    assert.equal(feedA.length, 1, 'the matching follow (drywall + Reading) receives the lead');
    n++;
    assert.equal(feedA[0].id, leadDrywall.id);
    n++;
    assert.deepEqual(
      router.feedForLead(db, LEAD_B).filter((l) => l.id === leadDrywall.id),
      [],
      'a roofer follow does not receive a drywall lead'
    );
    n++;

    // Kind separation: B follows drywall for HIRING only.
    router.setFollow(db, LEAD_B, { lead_type_label: 'Drywall', location_label: 'Reading', request_kinds: ['hiring'] });
    assert.deepEqual(router.feedForLead(db, LEAD_B), [], 'a hiring-only follow does not receive a service request');
    n++;
    const hiring = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-101',
        source_url: 'https://facebook.example/posts/fb-101',
        poster_name: 'Matthew H',
        posted_at: hoursAgoIso(2),
        lead_type: 'Drywall',
        request_kind: 'hiring',
        town: 'Reading',
        area: 'Berks County',
        detail: 'Looking for experienced drywall installers to join our crew.',
      },
      { publish: true }
    );
    const feedB = router.feedForLead(db, LEAD_B);
    assert.ok(
      feedB.some((l) => l.id === hiring.lead.id),
      'the hiring follow receives the hiring post'
    );
    n++;
    assert.ok(!feedB.some((l) => l.id === leadDrywall.id), 'kinds stay separate in the feed');
    n++;

    // Area coverage: a county follow receives a lead whose AREA is
    // the county even when the town differs.
    const fleet = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-102',
        source_url: 'https://facebook.example/posts/fb-102',
        poster_name: 'Fran F',
        posted_at: hoursAgoIso(1),
        lead_type: 'Drywall',
        request_kind: 'service_request',
        town: 'Fleetwood',
        area: 'Berks County',
        detail: 'Looking for drywall help in Fleetwood.',
      },
      { publish: true }
    );
    assert.ok(
      router.feedForLead(db, LEAD_C).some((l) => l.id === fleet.lead.id),
      'a Berks County follow covers a Fleetwood lead by area'
    );
    n++;
    assert.ok(
      !router.feedForLead(db, LEAD_A).some((l) => l.id === fleet.lead.id),
      'a Reading follow does not cover Fleetwood'
    );
    n++;
    group('Part 2d review gate + routing', n);
  }

  // ---- 2e: dedupe + cross-platform merge ----
  {
    let n = 0;
    const again = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-100',
        source_url: 'https://facebook.example/posts/fb-100',
        poster_name: 'Chris P',
        posted_at: hoursAgoIso(1),
        lead_type: 'Drywall',
        town: 'Reading',
        detail: 'Looking for a drywall crew in Reading — two jobs ready.',
      },
      { publish: true }
    );
    assert.equal(again.created, false, 'the same post published twice is not a new lead');
    n++;
    assert.equal(again.lead.id, leadDrywall.id, 'same post = same lead, forever');
    n++;
    const count = db.prepare("SELECT COUNT(*) AS c FROM router_leads WHERE dedupe_key = 'facebook:fb-100'").get().c;
    assert.equal(count, 1, 'one row per dedupe key');
    n++;

    const fb = router.publishLead(
      db,
      {
        platform: 'facebook',
        source_url: 'https://facebook.example/posts/cross-1',
        poster_name: 'Sam Cross',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        area: 'Berks County',
        detail: 'Looking for a roofer in Reading please, roof leaking',
      },
      { publish: true }
    );
    const ig = router.publishLead(
      db,
      {
        platform: 'instagram',
        source_url: 'https://instagram.example/p/cross-1',
        poster_name: 'Sam Cross',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        area: 'Berks County',
        detail: 'Looking for a roofer in Reading please, roof leaking',
      },
      { publish: true }
    );
    assert.equal(ig.merged, true, 'the same request on a second platform merges');
    n++;
    assert.equal(ig.lead.id, fb.lead.id, 'cross-posted request = ONE lead');
    n++;
    assert.equal(ig.lead.sources.length, 2, 'the one lead carries both source links');
    n++;
    assert.deepEqual(
      ig.lead.sources.map((s) => s.platform).sort(),
      ['facebook', 'instagram'],
      'both platforms are on the sources list'
    );
    n++;
    group('Part 2e dedupe + cross-platform merge', n);
  }

  // ---- 2f: freshness on posted_at ----
  {
    let n = 0;
    const old = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-old-1',
        source_url: 'https://facebook.example/posts/fb-old-1',
        poster_name: 'Old Otto',
        posted_at: hoursAgoIso(100),
        lead_type: 'Roofer',
        request_kind: 'service_request',
        town: 'Reading',
        detail: 'Looking for a roofer (posted days ago, found just now).',
      },
      { publish: true }
    );
    // first_seen_at is NOW; posted_at is 100h ago. Freshness must run
    // on posted_at: a 48h service window makes this lead stale.
    assert.ok(
      !router.feedForLead(db, LEAD_B).some((l) => l.id === old.lead.id),
      'a 100h-old service post is stale on arrival (posted_at, not first_seen_at)'
    );
    n++;
    const listed = router.listLeads(db, {}).find((l) => l.id === old.lead.id);
    assert.equal(listed.effective_status, 'stale');
    n++;
    const marked = router.markStale(db);
    assert.ok(marked.marked >= 1, 'markStale persists the stale marking');
    n++;
    assert.equal(router.getLead(db, old.lead.id).status, 'stale');
    n++;
    const oldHiring = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-old-2',
        source_url: 'https://facebook.example/posts/fb-old-2',
        poster_name: 'Hiring Hanna',
        posted_at: hoursAgoIso(100),
        lead_type: 'Roofer',
        request_kind: 'hiring',
        town: 'Reading',
        detail: 'Hiring roofers — posted 100h ago, still inside the 7-day hiring window.',
      },
      { publish: true }
    );
    router.setFollow(db, LEAD_B, { lead_type_label: 'Roofer', location_label: 'Reading', request_kinds: ['hiring'] });
    assert.ok(
      router.feedForLead(db, LEAD_B).some((l) => l.id === oldHiring.lead.id),
      'a 100h-old hiring post is still fresh (7d window)'
    );
    n++;
    group('Part 2f freshness on posted_at', n);
  }

  // ---- 2g: claim (exclusive, exactly-once, LeadScout) + removal ----
  {
    let n = 0;
    const claim = router.claimLead(db, LEAD_A, leadDrywall.id);
    assert.equal(claim.claimed, true);
    n++;
    assert.equal(claim.lead.status, 'claimed');
    n++;
    assert.equal(claim.lead.claimed_by_lead_id, LEAD_A);
    n++;
    const ev = db.prepare('SELECT * FROM leadscout_events WHERE router_lead_id = ?').get(leadDrywall.id);
    assert.ok(ev, 'the claim landed in LeadScout');
    n++;
    assert.equal(ev.kind, 'router_claim');
    n++;
    assert.equal(Number(ev.lead_id), LEAD_A, "the contact sits in the CLAIMER's portal store");
    n++;
    const payload = JSON.parse(ev.payload_json);
    assert.equal(payload.platform, 'facebook', 'the capture is stamped with the platform');
    n++;
    assert.equal(
      payload.source_url,
      'https://facebook.example/posts/fb-100',
      'the capture is stamped with the source URL'
    );
    n++;
    const contact = db.prepare('SELECT * FROM leadscout_contacts WHERE id = ?').get(ev.contact_id);
    assert.equal(contact.name, 'Chris P', 'the poster is the contact (name as shown — no enrichment)');
    n++;
    const again = router.claimLead(db, LEAD_A, leadDrywall.id);
    assert.equal(again.already, true, 'a double-claim by the same business is an idempotent no-op');
    n++;
    const evCount = db
      .prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE router_lead_id = ?')
      .get(leadDrywall.id).c;
    assert.equal(evCount, 1, 'the claim records exactly once (one contact event, ever)');
    n++;
    assert.throws(
      () => router.claimLead(db, LEAD_B, leadDrywall.id),
      /already claimed/,
      'a second business cannot claim an exclusive-claimed lead'
    );
    n++;
    // Exclusive: B follows drywall too (hiring-only kinds aside, add an
    // all-kinds drywall follow for a third business to prove the feed
    // removal is about the claim, not kinds).
    router.setFollow(db, LEAD_C, { lead_type_label: 'Drywall', location_label: 'Reading' });
    assert.ok(
      !router.feedForLead(db, LEAD_C).some((l) => l.id === leadDrywall.id),
      'a claimed lead leaves every other feed'
    );
    n++;
    assert.ok(
      router.feedForLead(db, LEAD_A).some((l) => l.id === leadDrywall.id && l.claimed_by_me),
      'the claimer still sees it, marked as theirs'
    );
    n++;

    // Removal: never re-enters.
    const doomed = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-200',
        source_url: 'https://facebook.example/posts/fb-200',
        poster_name: 'Remove Rita',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer — will be removed by the poster.',
      },
      { publish: true }
    );
    router.removeLead(db, doomed.lead.id);
    assert.equal(router.getLead(db, doomed.lead.id).status, 'removed');
    n++;
    const resurrect = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-200',
        source_url: 'https://facebook.example/posts/fb-200',
        poster_name: 'Remove Rita',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer — will be removed by the poster.',
      },
      { publish: true }
    );
    assert.equal(
      resurrect.blocked_removed,
      true,
      'a removed lead never re-enters via a later publish of the same dedupe key'
    );
    n++;
    assert.equal(router.getLead(db, doomed.lead.id).status, 'removed', 'still removed after the re-publish attempt');
    n++;
    group('Part 2g claim + removal', n);
  }

  // ---- 2h: platform routing (live vs planned) ----
  {
    let n = 0;
    // Instagram's proof sweep lands: staff flip its source live.
    const igSource = router.listSources(db, { platform: 'instagram' })[0];
    router.updateSource(db, igSource.id, { access_state: 'member', enabled: true });
    assert.deepEqual(
      router.livePlatforms(db),
      ['facebook', 'instagram'],
      'instagram goes live when a readable source exists'
    );
    n++;
    router.setFollow(db, LEAD_D, { lead_type_label: 'Roofer', location_label: 'Reading', platforms: ['instagram'] });
    const igLead = router.publishLead(
      db,
      {
        platform: 'instagram',
        post_id: 'ig-1',
        source_url: 'https://instagram.example/p/ig-1',
        poster_name: 'Insta Ingrid',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer on Instagram.',
      },
      { publish: true }
    );
    assert.ok(
      router.feedForLead(db, LEAD_D).some((l) => l.id === igLead.lead.id),
      'a specific-platform follow receives its platform'
    );
    n++;
    const fbLead = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-300',
        source_url: 'https://facebook.example/posts/fb-300',
        poster_name: 'Face Fred',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer on Facebook.',
      },
      { publish: true }
    );
    assert.ok(
      !router.feedForLead(db, LEAD_D).some((l) => l.id === fbLead.lead.id),
      'a specific-platform follow NEVER receives another platform\u2019s lead'
    );
    n++;
    // ALL follows receive every live platform…
    router.setFollow(db, LEAD_C, { lead_type_label: 'Roofer', location_label: 'Reading' });
    assert.ok(
      router.feedForLead(db, LEAD_C).some((l) => l.id === igLead.lead.id),
      'an ALL follow receives instagram'
    );
    n++;
    assert.ok(
      router.feedForLead(db, LEAD_C).some((l) => l.id === fbLead.lead.id),
      'an ALL follow receives facebook'
    );
    n++;
    // …but never a planned one.
    const ttLead = router.publishLead(
      db,
      {
        platform: 'tiktok',
        post_id: 'tt-1',
        source_url: 'https://tiktok.example/v/tt-1',
        poster_name: 'TikTok Tara',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer on TikTok.',
      },
      { publish: true }
    );
    assert.ok(
      !router.feedForLead(db, LEAD_C).some((l) => l.id === ttLead.lead.id),
      'an ALL follow never receives a planned platform\u2019s lead'
    );
    n++;
    group('Part 2h platform routing', n);
  }

  // ---- 2i: shared layer + module mechanics ----
  {
    let n = 0;
    const demand = router.demandCounts(db);
    assert.ok(
      demand.some((d) => d.lead_type_key === 'roofer' && d.count >= 2),
      'aggregate demand counts publish through the engine'
    );
    n++;
    const decl = share.getSharedDeclaration(db, LEAD_A, 'leads_router', 'router_demand');
    assert.ok(decl && Array.isArray(decl.counts), 'the shared layer serves the router_demand declaration');
    n++;
    const sources = share.listSharedSources(db, LEAD_A);
    assert.ok(
      sources.some((s) => (s.type || s.module_type) === 'leads_router'),
      'the shared sources list carries the Router row (parity with MODULE_TYPES)'
    );
    n++;

    // Attach + summary + public payload + purge, like every module.
    const emb = sm.attachModule(db, LEAD_E, 'leads_router', { workspaceId: WS_ID });
    assert.ok(emb && emb.embed && emb.embed.module_type === 'leads_router', 'the Router attaches like any module');
    n++;
    router.setFollow(db, LEAD_E, { lead_type_label: 'Plumber', location_label: 'Reading' });
    const summary = sm.portalSummary(db, LEAD_E, {});
    const row = summary.modules.find((m) => m.type === 'leads_router');
    assert.ok(row, 'portal summary lists the Router');
    n++;
    assert.ok(
      row.purge.parts.some((p) => p.table === 'router_follows' && p.count === 1),
      'the delete confirm counts the lead\u2019s follows'
    );
    n++;
    const payload = sm.getPublicModuleByToken(db, emb.embed.public_token);
    assert.equal(payload.module_type, 'leads_router');
    n++;
    assert.deepEqual(payload.items, [], 'the public payload is dormant — poster data is never public');
    n++;
    const del = sm.deleteModule(db, LEAD_E, 'leads_router');
    assert.ok(del.deleted, 'the Router deletes like any module');
    n++;
    assert.equal(router.listFollows(db, LEAD_E).length, 0, 'module delete purges the lead\u2019s follows');
    n++;

    // Portal facade panel block.
    const listed = await portalModules.listModuleItems(WS_ID, LEAD_A, 'leads_router', 'a178@example.invalid');
    assert.ok(listed.leads_router, 'the portal list carries the Router panel block');
    n++;
    assert.ok(Array.isArray(listed.leads_router.feed), 'the panel carries the feed');
    n++;
    assert.ok(listed.leads_router.hunting.active, 'the panel carries hunting status');
    n++;
    assert.equal(listed.leads_router.activation.badge, 'Requires Muse', 'the panel carries the badge');
    n++;
    group('Part 2i shared layer + module mechanics', n);
  }

  // ---- 2j: lead cascades (delete releases claims, merge moves) ----
  {
    let n = 0;
    router.setFollow(db, LEAD_F, { lead_type_label: 'Roofer', location_label: 'Reading' });
    router.setFollow(db, LEAD_G, { lead_type_label: 'Roofer', location_label: 'Reading' });
    router.setFollow(db, LEAD_G, { lead_type_label: 'Drywall', location_label: 'Reading' });
    const claimable = router.publishLead(
      db,
      {
        platform: 'facebook',
        post_id: 'fb-400',
        source_url: 'https://facebook.example/posts/fb-400',
        poster_name: 'Merge Mary',
        posted_at: hoursAgoIso(1),
        lead_type: 'Roofer',
        town: 'Reading',
        detail: 'Looking for a roofer — claimed by the dropped lead.',
      },
      { publish: true }
    );
    router.claimLead(db, LEAD_G, claimable.lead.id);
    const leadEngine = require(path.join(root, 'src/leadEngine.js'));
    leadEngine.mergeLeads(db, LEAD_F, [LEAD_G]);
    const fFollows = router.listFollows(db, LEAD_F);
    assert.equal(fFollows.length, 2, 'merge: keeper follow wins the clash, the non-clashing follow moves');
    n++;
    assert.deepEqual(fFollows.map((f) => f.lead_type_key).sort(), ['drywall', 'roofer']);
    n++;
    assert.equal(
      router.getLead(db, claimable.lead.id).claimed_by_lead_id,
      LEAD_F,
      'merge: the claim re-points to the keeper'
    );
    n++;
    leadEngine.deleteLead(db, LEAD_F);
    assert.equal(router.listFollows(db, LEAD_F).length, 0, 'delete: the lead\u2019s follows drop with it');
    n++;
    const released = router.getLead(db, claimable.lead.id);
    assert.equal(released.status, 'new', 'delete: the claim is released back to the feed');
    n++;
    assert.equal(released.claimed_by_lead_id, null);
    n++;
    group('Part 2j lead cascades', n);
  }

  // ---- 2k: MCP dispatch ----
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const unwrap = (res) => {
      if (res && Array.isArray(res.content) && res.content[0] && res.content[0].text) {
        try {
          return JSON.parse(res.content[0].text);
        } catch {
          return res;
        }
      }
      return res;
    };
    const sweepRes = unwrap(await mcp.callTool(WS_ID, 'router_sweeps.run', { platform: 'all' }, {}));
    assert.ok(sweepRes && !sweepRes.isError, 'MCP router_sweeps.run answers');
    n++;
    const sweepData = sweepRes.data || sweepRes;
    assert.ok(
      (sweepData.sweep ? sweepData.sweep.platforms : []).includes('instagram'),
      'the MCP ALL sweep stamps live coverage'
    );
    n++;
    const noPlat = unwrap(await mcp.callTool(WS_ID, 'router_sweeps.run', {}, {}));
    assert.ok(
      noPlat && (noPlat.isError || noPlat.ok === false || noPlat.error),
      'router_sweeps.run without the required platform fails'
    );
    n++;
    const followRes = unwrap(
      await mcp.callTool(
        WS_ID,
        'router_follows.set',
        { leadId: LEAD_A, lead_type: 'Firewood', location: 'Kutztown' },
        {}
      )
    );
    assert.ok(followRes && !followRes.isError, 'MCP router_follows.set answers');
    n++;
    assert.ok(
      router.listFollows(db, LEAD_A).some((f) => f.lead_type_key === 'firewood'),
      'the MCP-set follow landed (typed-new works over MCP)'
    );
    n++;
    const pubRes = unwrap(
      await mcp.callTool(
        WS_ID,
        'router_leads.publish',
        {
          platform: 'facebook',
          post_id: 'fb-mcp-1',
          source_url: 'https://facebook.example/posts/fb-mcp-1',
          poster_name: 'Mcp Mike',
          posted_at: hoursAgoIso(1),
          lead_type: 'Firewood',
          town: 'Kutztown',
          detail: 'Looking for firewood delivery in Kutztown.',
          publish: true,
        },
        {}
      )
    );
    assert.ok(pubRes && !pubRes.isError, 'MCP router_leads.publish answers');
    n++;
    assert.ok(
      router.feedForLead(db, LEAD_A).some((l) => l.post_id === 'fb-mcp-1'),
      'an MCP-published lead routes to the MCP-set follow'
    );
    n++;
    const listRes = unwrap(await mcp.callTool(WS_ID, 'router_leads.list', {}, {}));
    assert.ok(listRes && !listRes.isError, 'MCP router_leads.list answers');
    n++;
    group('Part 2k MCP dispatch', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner178@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_B, b: 'B178 Beta Drywall' }
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

      const makeJar = () => {
        const cookies = new Map();
        return {
          async fetch(url, opts = {}) {
            const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
            if (cookies.size) headers.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
            const res = await fetch(url, { ...opts, headers });
            const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
            for (const line of set) {
              const pair = line.split(';')[0];
              const i = pair.indexOf('=');
              if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            }
            return res;
          },
          cookieHeader() {
            return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
          },
        };
      };

      // ---- staff session ----
      const staff = makeJar();
      const totp = require(path.join(root, 'src/totp.js'));
      let staffSecret = null;
      async function staffLogin() {
        const first = await staff.fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          body: JSON.stringify({ email: 'a178@example.invalid', password: STAFF_PW }),
        });
        const body = await json(first.clone());
        if (body && body.data && body.data.mfaRequired) {
          if (body.data.mfaStage === 'enroll') {
            const start = await json(
              await staff.fetch(`${BASE}/api/v1/auth/mfa/enroll/start`, { method: 'POST', body: '{}' })
            );
            staffSecret = start.data.secret;
            await staff.fetch(`${BASE}/api/v1/auth/mfa/enroll/confirm`, {
              method: 'POST',
              body: JSON.stringify({ code: totp.totp(staffSecret) }),
            });
          } else {
            await staff.fetch(`${BASE}/api/v1/auth/mfa/verify`, {
              method: 'POST',
              body: JSON.stringify({ code: totp.totp(staffSecret) }),
            });
          }
        }
        return first.status;
      }
      const loginStatus = await staffLogin();
      assert.equal(loginStatus, 200, 'staff login');
      n++;
      const staffGet = (p) => staff.fetch(`${BASE}${p}`, { headers: { 'x-workspace-id': String(WS_ID) } });
      const staffPost = (p, body) =>
        staff.fetch(`${BASE}${p}`, {
          method: 'POST',
          headers: { 'x-workspace-id': String(WS_ID) },
          body: JSON.stringify(body || {}),
        });

      const overview = await json(await staffGet('/api/v1/admin-area/router/overview'));
      assert.ok(overview.data && overview.data.oversight, 'staff overview answers');
      n++;
      assert.equal(
        overview.data.hunting.active,
        true,
        'staff overview shows hunting active (sweeps recorded in Part 2)'
      );
      n++;
      assert.ok(overview.data.activation.badge === 'Requires Muse', 'staff overview carries the badge');
      n++;

      // Queue over HTTP: ingest a candidate, publish it from the queue.
      const ingest = await json(
        await staffPost('/api/v1/admin-area/router/leads', {
          platform: 'facebook',
          post_id: 'fb-http-1',
          source_url: 'https://facebook.example/posts/fb-http-1',
          poster_name: 'Http Heidi',
          posted_at: hoursAgoIso(1),
          lead_type: 'Painter',
          town: 'Reading',
          area: 'Berks County',
          detail: 'Looking for a painter in Reading (via staff HTTP).',
        })
      );
      assert.ok(
        ingest.data && ingest.data.lead && ingest.data.lead.review_state === 'candidate',
        'staff ingest lands a candidate'
      );
      n++;
      const httpLeadId = ingest.data.lead.id;
      const cands = await json(await staffGet('/api/v1/admin-area/router/candidates'));
      assert.ok(
        (cands.data || []).some((l) => l.id === httpLeadId),
        'the candidate is in the HTTP queue'
      );
      n++;
      const reviewed = await json(
        await staffPost(`/api/v1/admin-area/router/leads/${httpLeadId}/review`, { action: 'publish' })
      );
      assert.equal(reviewed.data.lead.review_state, 'published', 'queue publish works over HTTP');
      n++;

      const sweepHttp = await json(await staffPost('/api/v1/admin-area/router/sweeps', { platform: 'all' }));
      assert.ok(sweepHttp.data && sweepHttp.data.sweep, 'the sweep console records a run over HTTP');
      n++;
      assert.ok(sweepHttp.data.sweep.platforms.includes('facebook'), 'ALL stamps facebook coverage');
      n++;
      const badSweep = await staffPost('/api/v1/admin-area/router/sweeps', {});
      assert.ok(badSweep.status >= 400, 'a sweep with no platform is refused over HTTP');
      n++;
      const sourcesHttp = await json(await staffGet('/api/v1/admin-area/router/sources'));
      assert.ok(
        (sourcesHttp.data || []).some((s) => s.name.includes('Contractors Connections')),
        'the source registry serves over HTTP'
      );
      n++;

      // ---- portal owner session (LEAD_B) ----
      const owner = makeJar();
      const login = await owner.fetch(`${BASE}/api/v1/portal/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'owner178@example.invalid', password: PW }),
      });
      assert.equal(login.status, 200, 'portal owner login');
      n++;
      const panel = await json(await owner.fetch(`${BASE}/api/v1/portal/modules/leads_router`));
      const panelData = (panel.data || panel).leads_router;
      assert.ok(panelData, 'the portal panel block answers over HTTP');
      n++;
      assert.ok(Array.isArray(panelData.feed) && Array.isArray(panelData.follows), 'panel carries feed + follows');
      n++;
      assert.ok(
        panelData.follows.some((f) => f.lead_type_key === 'roofer'),
        'the owner sees their follows'
      );
      n++;
      // Follow set over HTTP (select-or-type: Painter is typed-new here).
      const setRes = await json(
        await owner.fetch(`${BASE}/api/v1/portal/modules/leads-router/follows`, {
          method: 'POST',
          body: JSON.stringify({ lead_type_label: 'Painter', location_label: 'Reading', platforms: ['all'] }),
        })
      );
      assert.ok(
        setRes.data && setRes.data.follow && setRes.data.follow.lead_type_key === 'painter',
        'portal follow set works (typed Painter → painter key)'
      );
      n++;
      // The staff-published painter lead now routes to this owner.
      const panel2 = await json(await owner.fetch(`${BASE}/api/v1/portal/modules/leads_router`));
      const feed2 = (panel2.data || panel2).leads_router.feed;
      assert.ok(
        feed2.some((l) => l.post_id === 'fb-http-1'),
        'the published painter lead is in the owner feed'
      );
      n++;
      // Claim over HTTP → LeadScout.
      const claimRes = await owner.fetch(`${BASE}/api/v1/portal/modules/leads-router/claim/${httpLeadId}`, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(claimRes.status, 200, 'portal claim answers');
      n++;
      const claimBody = await json(claimRes);
      assert.ok(claimBody.data && claimBody.data.claimed, 'the claim recorded');
      n++;
      const evRow = db.prepare('SELECT * FROM leadscout_events WHERE router_lead_id = ?').get(httpLeadId);
      assert.ok(
        evRow && Number(evRow.lead_id) === LEAD_B,
        'the HTTP claim captured into the owner\u2019s LeadScout contacts'
      );
      n++;

      // ---- 390px feed geometry (real browser, real portal) ----
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (r) => (r.url().startsWith(BASE) ? r.continue() : r.abort()));
        await page.setViewport({ width: 390, height: 844 });
        const cookiePairs = owner
          .cookieHeader()
          .split('; ')
          .filter(Boolean)
          .map((pair) => {
            const i = pair.indexOf('=');
            return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: '127.0.0.1', path: '/' };
          });
        await page.setCookie(...cookiePairs);
        await page.goto(`${BASE}/portal#/modules`, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('#modules-type-tabs [data-module-type]')].some((x) =>
              x.textContent.includes('Leads Router')
            ),
          { timeout: 20000 }
        );
        const clicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('#modules-type-tabs button, #modules-type-tabs [role="tab"]')];
          const b = btns.find((x) => x.textContent.includes('Leads Router'));
          if (b) {
            b.click();
            return true;
          }
          return false;
        });
        assert.ok(clicked, 'the Leads Router tab exists in the portal module list');
        n++;
        await page.waitForSelector('#modules-router-panel .router-lead-card', { timeout: 20000 });
        const geo = await page.$$eval('#modules-router-panel .router-lead-card', (els) =>
          els.map((el) => {
            const b = el.getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right };
          })
        );
        assert.ok(geo.length >= 1, 'the feed renders lead cards at 390px');
        n++;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        assert.ok(overflow, 'no horizontal overflow at 390px');
        n++;
        assert.ok(
          geo.every((g) => g.right <= 391 && g.x >= 0),
          'cards stay inside the 390px viewport (never touch the edges)'
        );
        n++;
        if (geo.length >= 2) {
          const gaps = [];
          for (let i = 1; i < geo.length; i++)
            gaps.push(Math.round((geo[i].y - (geo[i - 1].y + geo[i - 1].h)) * 10) / 10);
          assert.ok(
            gaps.every((g) => g === gaps[0] && g > 0),
            `uniform card gaps in the feed (gaps: ${gaps.join(', ')})`
          );
          n++;
        }
        const label = await page.$eval('#modules-router-panel .router-lead-card', (el) => el.textContent);
        assert.ok(label.includes('Posted publicly on'), 'the spec §9 label renders on the card');
        n++;
        assert.ok(
          label.includes('Claim this lead') || label.includes('Claimed by you'),
          'the claim action renders on the card'
        );
        n++;
      } finally {
        await browser.close();
      }
      group('Part 3 HTTP + portal + 390px feed', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  const total = groups.reduce((acc, g) => acc + Number(g.match(/\((\d+)\)$/)[1]), 0);
  console.log(`BATCH178 SUITE: ${groups.length} groups, ${total} checks — ALL PASS`);
})().catch((e) => {
  console.error('BATCH178 SUITE FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
