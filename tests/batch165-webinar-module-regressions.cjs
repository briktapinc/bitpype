'use strict';
/**
 * Batch 165 — WEBINAR AS A MODULE (Ely's follow-up to Batch 163,
 * 2026-11-08: "Webinar should be a module. Make it a module — keep
 * what we have already built though.").
 *
 * Batch 163's platform webinars stay exactly as built (the batch163
 * suite passes UNCHANGED on this tree — run it alongside). This
 * batch adds the SAME capability as a per-site module, reusing the
 * 163 engine (server/webinars.js): webinars gain scope columns
 * (workspace_id + lead_id + website_id; platform rows are the
 * workspace-1/no-website case), the portal owner manages their own
 * site's webinars, the public gate/room live under the site's own
 * URL via the webinar public API + exported shells, gate success
 * captures into THAT SITE's workspace LeadScout, and the module
 * works in single-site clone mode.
 *
 * Part 1 — wiring pins: type + registry parity, script version,
 *   portal/nav/MCP surfaces, scoped schema in both migrate branches.
 * Part 2 — engine + fixtures in-process: scoped CRUD, code regen
 *   (old code dies), dedupe + capture into the site workspace,
 *   cross-site isolation, chat hide semantics, module-delete purge,
 *   export shell cache + materialized shell, sync payload marker.
 * Part 3 — HTTP over the real server: portal owner A/B isolation,
 *   public API gate → room → chat lifecycle → SSE → host console,
 *   gate lockout, platform (163) surface smoke, detach gating.
 * Part 4 — standalone travel (seed carries ONLY the site's module
 *   webinars + their registrations; platform rows never travel)
 *   and a single-site clone boot serving the clone's own gate/room.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b165-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch165', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 53).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b165@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['B165', 'Boot', 'Pass', 'w0w'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B165 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';

const PORT = 33165;
const BASE = `http://127.0.0.1:${PORT}`;
const PORTAL_PW = ['B165', 'Portal', 'Pass', '99'].join('-');
const LEAD_A = 16501;
const LEAD_B = 16502;
const SITE_A = 16511;
const SITE_B = 16512;
const EMAIL_A = 'owner-a165@example.invalid';
const EMAIL_B = 'owner-b165@example.invalid';

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

/* ================================================================== */
/* Part 1 — wiring pins                                                */
/* ================================================================== */
function part1() {
  let n = 0;
  const sm = require(path.join(root, 'server', 'siteModules.js'));
  assert.ok(sm.MODULE_TYPES.includes('webinar'), 'webinar is a module type');
  assert.equal(sm.MODULE_TYPES.length, 30, 'MODULE_TYPES 29 -> 30 on this tree');
  assert.equal(sm.MODULE_SCRIPT_VER, 'mod40', 'MODULE_SCRIPT_VER bumped for the webinar renderer');
  assert.equal(sm.MODULE_META.webinar.defaultSlug, 'webinars', 'webinar meta slug');
  assert.equal(sm.MODULE_META.webinar.label, 'Webinars', 'webinar meta label');
  n += 5;
  const share = require(path.join(root, 'server', 'moduleShare.js'));
  for (const t of sm.MODULE_TYPES) {
    assert.ok(share.SHARE_REGISTRY[t], `registry parity: entry for ${t}`);
  }
  assert.equal(share.SHARE_REGISTRY.webinar.kind, 'none', 'webinar registry kind none in v1');
  assert.ok(share.SHARE_REGISTRY.webinar.reason.includes('async'), 'webinar registry reason is honest');
  n += 3;
  {
    const server = read('server.js');
    assert.ok(server.includes('webinarsPublicRoutes.siteRouter'), 'server.js mounts the clone site router');
    assert.ok(server.includes('X-Bitpype-Webinar-Session'), 'CORS allows the webinar session header');
    const pub = require(path.join(root, 'server', 'routes', 'webinarsPublic.js'));
    assert.equal(typeof pub.siteRouter, 'function', 'webinarsPublic exports siteRouter');
    assert.equal(typeof pub.makeGateLimit, 'function', 'webinarsPublic exports the gate limiter factory');
    n += 4;
  }
  {
    const portal = read('public/js/portal.js');
    assert.ok(portal.includes("{ type: 'webinar', label: 'Webinars' }"), 'portal module nav carries webinar');
    assert.ok(portal.includes('function renderWebinarPanel()'), 'portal webinar panel');
    assert.ok(read('public/portal.html').includes('modules-webinar-panel'), 'portal.html webinar panel host');
    assert.ok(read('public/js/moduleIcons.js').includes('webinar:'), 'webinar icon');
    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes('renderWebinar'), 'module-embed dispatches the webinar card');
    assert.ok(fs.existsSync(path.join(root, 'public', 'js', 'webinar-embed.js')), 'webinar-embed.js ships');
    n += 6;
  }
  {
    const catalog = read('src/mcpCatalog.js');
    for (const t of ['webinar.list', 'webinar.create', 'webinar.update', 'webinar.delete', 'webinar.regenCode', 'webinar.registrations']) {
      assert.ok(catalog.includes(`name: '${t}'`), `mcpCatalog carries ${t}`);
    }
    assert.ok(catalog.includes("'webinar',"), 'mcpCatalog moduleType enums carry webinar');
    const parity = read('src/mcpParityTools.js');
    assert.ok(parity.includes("'webinar.list': parityEntry"), 'parity tools carry webinar entries');
    const hosted = read('server/mcp.js');
    assert.ok(hosted.includes("name === 'webinar.list'"), 'hosted MCP handler for webinar.list');
    assert.ok(hosted.includes("'webinar.regenCode',"), 'hosted MCP entitlement list carries webinar tools');
    const clientMcp = read('server/clientMcp.js');
    assert.ok(!clientMcp.includes('webinar.list'), 'design agent surface has no webinar item tools');
    n += 5;
  }
  {
    const dbjs = read('server/db.js');
    const creates = (dbjs.match(/CREATE TABLE IF NOT EXISTS webinars \(/g) || []).length;
    assert.equal(creates, 2, 'both migrate branches create webinars');
    assert.ok(dbjs.includes("ensureColumnSqlite(db, 'webinars', 'workspace_id'"), 'sqlite scope ensure');
    assert.ok(dbjs.includes("ensureColumnMysql(conn, 'webinars', 'workspace_id'"), 'mysql scope ensure');
    assert.ok(dbjs.includes('lead_id INTEGER') && dbjs.includes('website_id INTEGER'), 'sqlite scope columns in CREATE');
    assert.ok(dbjs.includes('lead_id BIGINT UNSIGNED NULL'), 'mysql scope columns in CREATE');
    n += 5;
  }
  group('Part 1 wiring + parity', n);
}

/* ================================================================== */
/* Fixtures (shared by Parts 2–4)                                      */
/* ================================================================== */
let WS = 0;
let db = null; // tenant db for WS
let tokenA = '';
let tokenB = '';

async function fixtures() {
  const platformDb = require(path.join(root, 'server', 'db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server', 'workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server', 'workspaceDb.js'));
  const sm = require(path.join(root, 'server', 'siteModules.js'));
  const bcrypt = require('bcryptjs');
  const a = await workspace.createUserWithWorkspace({
    email: EMAIL_A,
    password: ['batch165', 'ws', 'password'].join('-'),
    name: 'A165',
    workspaceName: 'Batch165 WS',
  });
  WS = Number(a.workspaceId);
  // Paid plan for the workspace owner so portal module calls pass
  // requireSiteModules (effectivePlan takes the max of workspace +
  // user plan).
  await platformDb.query(
    "UPDATE users SET billing_plan = 'pro', subscription_status = 'active' WHERE email = :e",
    { e: EMAIL_A }
  );
  db = openWorkspaceDb(WS);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B165 Alpha Blooms', EMAIL_A],
    [LEAD_B, 'B165 Beta Blooms', EMAIL_B],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
  }
  const pages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'heading', content: { title: 'B165 Blooms' } },
        { type: 'text', content: { body: 'Fresh flowers from the Batch 165 fixture garden.' } },
      ],
    },
  ];
  const theme = {
    colors: { primary: '#1d6f4f', accent: '#e8b4b8', bg: '#fffaf5', text: '#22301f' },
    fonts: { heading: 'Fraunces', body: 'Figtree' },
  };
  db.prepare('INSERT INTO websites (id, lead_id, name, pages, theme, preview_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    SITE_A,
    LEAD_A,
    'Alpha Site',
    JSON.stringify(pages),
    JSON.stringify(theme),
    'https://a165.pages.dev'
  );
  db.prepare('INSERT INTO websites (id, lead_id, name, pages, theme, preview_url) VALUES (?, ?, ?, ?, ?, ?)').run(
    SITE_B,
    LEAD_B,
    'Beta Site',
    JSON.stringify(pages),
    JSON.stringify(theme),
    'https://b165.pages.dev'
  );
  for (const [email, lead, name] of [
    [EMAIL_A, LEAD_A, 'B165 Alpha Blooms'],
    [EMAIL_B, LEAD_B, 'B165 Beta Blooms'],
  ]) {
    await platformDb.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: email, h: bcrypt.hashSync(PORTAL_PW, 12), w: WS, l: lead, b: name }
    );
  }
  // Attach the Webinar module to both sites.
  tokenA = sm.attachModule(db, LEAD_A, 'webinar', { workspaceId: WS }).embed.public_token;
  tokenB = sm.attachModule(db, LEAD_B, 'webinar', { workspaceId: WS }).embed.public_token;
  assert.ok(tokenA && tokenB && tokenA !== tokenB, 'both sites attached with distinct tokens');
  return { platformDb };
}

/* ================================================================== */
/* Part 2 — engine + portal facade, in-process                         */
/* ================================================================== */
async function part2() {
  let n = 0;
  const sm = require(path.join(root, 'server', 'siteModules.js'));
  const webinars = require(path.join(root, 'server', 'webinars.js'));
  const portal = require(path.join(root, 'server', 'portalModules.js'));

  // A platform webinar (Batch 163 shape: no scope). The engine
  // round-trip IS the schema proof on both dialects: the row comes
  // back carrying the scope fields (Part 1 pins the DDL text).
  const platformW = await webinars.createWebinar(
    { title: 'Platform Kickoff 165', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', scheduledAt: '2026-12-01T19:00' },
    null
  );
  assert.equal(platformW.workspaceId, 1, 'platform webinar defaults to workspace 1');
  assert.equal(platformW.websiteId, null, 'platform webinar has no website');
  assert.equal(platformW.leadId, null, 'platform webinar has no lead');
  assert.equal(platformW.youtubeId, 'dQw4w9WgXcQ', 'youtube parsed to ID');
  n += 4;

  // Site A webinar through the portal facade (the owner's path).
  const created = await portal.createModuleItem(
    WS,
    LEAD_A,
    'webinar',
    {
      title: 'Alpha Garden Tour Live',
      description: 'A walk through the alpha garden.',
      scheduledAt: '2026-12-03T18:30',
      youtube: 'https://youtu.be/dQw4w9WgXcQ',
    },
    EMAIL_A
  );
  const wA = created.item;
  assert.equal(wA.workspaceId, WS, 'site webinar carries the workspace');
  assert.equal(wA.leadId, LEAD_A, 'site webinar carries the lead');
  assert.equal(wA.websiteId, SITE_A, 'site webinar carries the website');
  assert.equal(wA.slug, 'alpha-garden-tour-live', 'slug derived from title');
  assert.equal(wA.accessCode.length, 7, 'code is 7 chars');
  assert.ok(!/[01OIL]/.test(wA.accessCode), 'code alphabet unambiguous');
  assert.equal(wA.scheduledAt, '2026-12-03T23:30:00.000Z', 'NY wall time stored as UTC');
  n += 7;

  // Lists are scope-pure.
  {
    const siteList = await webinars.listWebinarsForSite(WS, LEAD_A);
    assert.equal(siteList.length, 1, 'site list has exactly its own webinar');
    assert.equal(siteList[0].id, wA.id);
    const platList = await webinars.listWebinars();
    assert.ok(platList.some((w) => w.id === platformW.id), 'platform list has the platform webinar');
    assert.ok(!platList.some((w) => w.id === wA.id), 'platform list never shows site webinars');
    const bList = await webinars.listWebinarsForSite(WS, LEAD_B);
    assert.equal(bList.length, 0, 'site B list is empty');
    n += 5;
  }

  // Slug getters are scope-pure.
  {
    assert.equal((await webinars.getSiteWebinarBySlug(WS, LEAD_A, wA.slug)).id, wA.id, 'site getter finds its own');
    assert.equal(await webinars.getSiteWebinarBySlug(WS, LEAD_B, wA.slug), null, 'site getter never crosses sites');
    assert.equal(await webinars.getPlatformWebinarBySlug(wA.slug), null, 'platform getter never serves a site slug');
    assert.equal((await webinars.getPlatformWebinarBySlug(platformW.slug)).id, platformW.id, 'platform getter finds its own');
    assert.equal(await webinars.getSiteWebinarBySlug(WS, LEAD_A, platformW.slug), null, 'site getter never serves a platform slug');
    n += 5;
  }

  // Cross-scope writes read as NOT_FOUND.
  {
    await assert.rejects(
      () => portal.updateModuleItem(WS, LEAD_B, 'webinar', wA.id, { title: 'Hijacked' }, EMAIL_B),
      (e) => e.code === 'NOT_FOUND',
      'site B cannot update site A webinar'
    );
    await assert.rejects(
      () => portal.deleteModuleItem(WS, LEAD_B, 'webinar', wA.id, EMAIL_B),
      (e) => e.code === 'NOT_FOUND',
      'site B cannot delete site A webinar'
    );
    const still = await webinars.getWebinarById(wA.id);
    assert.equal(still.title, 'Alpha Garden Tour Live', 'webinar untouched by cross-scope attempts');
    n += 3;
  }

  // Portal list carries the share link on the site's own URL.
  {
    const listed = await portal.listModuleItems(WS, LEAD_A, 'webinar', EMAIL_A);
    assert.equal(listed.items.length, 1, 'portal list has the webinar');
    assert.equal(
      listed.items[0].share_url,
      `https://a165.pages.dev/webinar/${wA.slug}`,
      'share link = view-site base + /webinar/<slug>'
    );
    n += 2;
  }

  // Code regeneration: old code dies, new code works.
  const regen = await portal.regenWebinarCode(WS, LEAD_A, wA.id, EMAIL_A);
  const newCode = regen.item.accessCode;
  assert.notEqual(newCode, wA.accessCode, 'regen mints a fresh code');
  {
    await assert.rejects(
      () => webinars.registerWithCode(regen.item, { name: 'Old Code', email: 'old165@example.invalid', phone: '6105550101', code: wA.accessCode }),
      (e) => e.code === 'INVALID_CODE',
      'old code dies on regen'
    );
    n += 2;
  }

  // Gate registration + dedupe + capture into the SITE workspace.
  const regInput = { name: 'Eli Test', email: 'eli165@example.invalid', phone: '+1 (610) 555-0123', code: newCode };
  const reg1 = await webinars.registerWithCode(regen.item, regInput);
  const reg2 = await webinars.registerWithCode(regen.item, regInput);
  assert.equal(reg2.id, reg1.id, 're-entry dedupes to one registration');
  assert.ok(reg1.contactId, 'registration carries the LeadScout contact id');
  {
    const contacts = db
      .prepare("SELECT * FROM leadscout_contacts WHERE email_norm = 'eli165@example.invalid'")
      .all();
    assert.equal(contacts.length, 1, 'exactly one contact in the SITE workspace');
    const events = db
      .prepare('SELECT * FROM leadscout_events WHERE webinar_registration_id = ?')
      .all(reg1.id);
    assert.equal(events.length, 1, 'exactly one capture event');
    assert.ok(String(events[0].source_label || events[0].source || '').includes('Webinar — Alpha Garden Tour Live') || String(JSON.stringify(events[0])).includes('Webinar'), 'event carries the webinar source');
    const regs = await webinars.listRegistrations(wA.id);
    assert.equal(regs.length, 1, 'one registration row');
    n += 5;
  }

  // Chat at engine level: post, host post, hide semantics.
  {
    const wNow = await webinars.getWebinarById(wA.id);
    const m1 = await webinars.postMessage(wNow, { registration: reg1, body: 'Hello from the garden?' });
    assert.equal(m1.isHost, false, 'visitor message not host');
    const m2 = await webinars.postMessage(wNow, { hostName: 'Host', body: 'Welcome in!' });
    assert.equal(m2.isHost, true, 'host message badged');
    await webinars.setMessageHidden(wA.id, m1.id, true);
    const visitorView = await webinars.listMessages(wA.id, { includeHidden: false });
    assert.ok(!visitorView.some((m) => m.id === m1.id), 'hidden message gone for visitors');
    assert.ok(visitorView.some((m) => m.id === m2.id), 'host message visible');
    const ownerView = await webinars.listMessages(wA.id, { includeHidden: true });
    assert.ok(ownerView.some((m) => m.id === m1.id && m.hidden), 'owner still sees it, marked hidden');
    n += 5;
  }

  // Sync payload: deferred marker, no items baked.
  {
    const payload = sm.getPublicModuleByToken(db, tokenA);
    assert.equal(payload.module_type, 'webinar', 'payload is the webinar module');
    assert.deepEqual(payload.webinar, { deferred: true }, 'payload carries the deferred marker');
    assert.deepEqual(payload.items, [], 'no webinar items baked into the sync payload');
    assert.equal(sm.moduleItemCount(db, LEAD_A, 'webinar'), 0, 'sync count stays 0 (async store)');
    n += 4;
  }

  // Export: shell cache written on create; materialize ships the shell.
  {
    const cacheRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(`webinar_shells.${SITE_A}`);
    assert.ok(cacheRow, 'shell cache row exists for site A');
    const shells = JSON.parse(cacheRow.value);
    assert.ok(shells.some((s) => s.slug === wA.slug), 'cache lists the site webinar');
    const engine = require(path.join(root, 'src', 'websiteEngine.js'));
    const pages = JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = ?').get(SITE_A).pages);
    const theme = JSON.parse(db.prepare('SELECT theme FROM websites WHERE id = ?').get(SITE_A).theme);
    const html = engine.buildWebinarPage(pages, theme, { token: tokenA, slug: wA.slug, title: wA.title });
    assert.ok(html.includes('data-bitpype-webinar-root'), 'shell carries the webinar root');
    assert.ok(html.includes(`data-slug="${wA.slug}"`), 'shell carries the slug');
    assert.ok(html.includes('/js/webinar-embed.js'), 'shell loads the webinar client');
    const domain = require(path.join(root, 'server', 'domain.js'));
    const exported = domain.materializeWebsiteExport(db, WS, SITE_A);
    assert.ok((exported.files || []).includes(`webinar/${wA.slug}.html`), 'materialize ships the shell file');
    assert.ok(fs.existsSync(path.join(exported.dir, 'webinar', `${wA.slug}.html`)), 'shell file on disk');
    n += 6;
  }

  // Module delete purge (site B): its webinars go with the module.
  {
    const createdB = await portal.createModuleItem(
      WS,
      LEAD_B,
      'webinar',
      { title: 'Beta One-Off', scheduledAt: '2026-12-05T19:00' },
      EMAIL_B
    );
    assert.equal((await webinars.listWebinarsForSite(WS, LEAD_B)).length, 1, 'B has one webinar');
    await portal.deleteSiteModule(WS, LEAD_B, 'webinar', EMAIL_B);
    assert.equal((await webinars.listWebinarsForSite(WS, LEAD_B)).length, 0, 'delete purged B webinars');
    assert.equal((await webinars.listWebinarsForSite(WS, LEAD_A)).length, 1, 'A webinars untouched by B purge');
    assert.ok(createdB.item.id > 0);
    n += 4;
  }

  group('Part 2 engine + facade', n);
  return { platformW, wA, codeA: newCode, reg1 };
}

/* ================================================================== */
/* Part 3 — HTTP over the real server (platform mode)                  */
/* ================================================================== */
function makeJar(base) {
  const cookies = new Map();
  const call = async (method, p, body, opts = {}) => {
    const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
    if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body != null && opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else if (body != null) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  };
  return {
    cookies,
    get: (p, o) => call('GET', p, null, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, o) => call('DELETE', p, null, o),
  };
}
const asJson = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
};

function spawnServer(extraEnv, port) {
  return spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitReady(port, child, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (child.exitCode != null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function part3(ctx) {
  let n = 0;
  const { platformW, wA, codeA } = ctx;
  const child = spawnServer({}, PORT);
  let errBuf = '';
  child.stderr.on('data', (d) => (errBuf += d));
  try {
    const ready = await waitReady(PORT, child);
    assert.ok(ready, 'server became ready. stderr tail: ' + errBuf.slice(-400));

    // Portal login for both owners.
    const jarA = makeJar(BASE);
    const jarB = makeJar(BASE);
    for (const [jar, email] of [
      [jarA, EMAIL_A],
      [jarB, EMAIL_B],
    ]) {
      const res = await jar.post('/api/v1/portal/login', { email, password: PORTAL_PW });
      assert.equal(res.status, 200, `portal login ${email}`);
    }
    n += 2;

    // Owner isolation over HTTP.
    {
      const listA = (await asJson(await jarA.get('/api/v1/portal/modules/webinar'))).data;
      assert.ok(listA.items.some((w) => w.id === wA.id), 'A sees own webinar over HTTP');
      assert.equal(listA.items[0].share_url, `https://a165.pages.dev/webinar/${wA.slug}`, 'HTTP share link');
      const listB = (await asJson(await jarB.get('/api/v1/portal/modules/webinar'))).data;
      assert.ok(!listB.items.some((w) => w.id === wA.id), 'B never sees A webinar');
      const hijack = await jarB.put(`/api/v1/portal/modules/webinar/${wA.id}`, { title: 'Hijacked' });
      assert.equal(hijack.status, 404, 'B update of A webinar -> 404');
      n += 4;
    }

    const api = `/api/v1/modules/public/webinar/${tokenA}/${wA.slug}`;

    // Public list: only site A's webinars.
    {
      const res = await fetch(`${BASE}/api/v1/modules/public/webinar/${tokenA}/list`);
      const body = await asJson(res);
      assert.equal(res.status, 200, 'public list 200');
      assert.deepEqual(body.webinars.map((w) => w.slug), [wA.slug], 'public list = site A only');
      assert.ok(!('accessCode' in body.webinars[0]) && !('access_code' in body.webinars[0]), 'no code in public shape');
      const cross = await fetch(`${BASE}/api/v1/modules/public/webinar/${tokenB}/${wA.slug}/state`);
      assert.equal(cross.status, 404, 'A slug under B token -> 404');
      n += 4;
    }

    // Gate: wrong code 403, right code session; chat closed while scheduled.
    let session = '';
    {
      const bad = await fetch(`${BASE}${api}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vic', email: 'vic165@example.invalid', phone: '6105550119', code: 'ZZZZZZZ' }),
      });
      assert.equal(bad.status, 403, 'wrong code -> 403');
      const good = await fetch(`${BASE}${api}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vic Visitor', email: 'vic165@example.invalid', phone: '6105550119', code: codeA }),
      });
      const goodBody = await asJson(good);
      assert.equal(good.status, 200, 'right code -> 200');
      session = goodBody.session;
      assert.ok(session && session.split('.').length === 2, 'signed session token issued');
      const state = await asJson(
        await fetch(`${BASE}${api}/state`, { headers: { 'x-bitpype-webinar-session': session } })
      );
      assert.equal(state.registered, true, 'state registered with session');
      assert.equal(state.webinar.chat_open, false, 'chat closed while scheduled');
      const post = await fetch(`${BASE}${api}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bitpype-webinar-session': session },
        body: JSON.stringify({ body: 'too early' }),
      });
      assert.equal(post.status, 403, 'chat post refused while scheduled');
      n += 6;
    }

    // Session isolation: A's session means nothing on B's webinar.
    {
      // Part 2's purge test removed B's module install — re-attach
      // (fresh embed token) before creating B's HTTP webinar.
      const reattached = await asJson(await jarB.post('/api/v1/portal/modules/webinar/attach', {}));
      assert.ok(reattached.data && reattached.data.embed && reattached.data.embed.public_token, 'B re-attached');
      tokenB = reattached.data.embed.public_token;
      const wB2 = await (
        await jarB.post('/api/v1/portal/modules/webinar', {
          title: 'Beta Live Night',
          scheduledAt: '2026-12-06T19:00',
          youtube: 'dQw4w9WgXcQ',
        })
      ).json();
      const stateB = await asJson(
        await fetch(`${BASE}/api/v1/modules/public/webinar/${tokenB}/${wB2.data.item.slug}/state`, {
          headers: { 'x-bitpype-webinar-session': session },
        })
      );
      assert.equal(stateB.registered, false, 'A session does not register the visitor for B');
      n += 1;
      ctx.wB2 = wB2.data.item;
    }

    // Go live (owner), visitor chats, SSE carries it, host replies, hide.
    {
      const live = await jarA.put(`/api/v1/portal/modules/webinar/${wA.id}`, { status: 'live' });
      assert.equal(live.status, 200, 'owner flips live');
      const state = await asJson(
        await fetch(`${BASE}${api}/state`, { headers: { 'x-bitpype-webinar-session': session } })
      );
      assert.equal(state.webinar.chat_open, true, 'chat open while live');

      // SSE first (backlog empty), then post and watch it arrive.
      const ac = new AbortController();
      const sseRes = await fetch(`${BASE}${api}/chat/stream?t=${encodeURIComponent(session)}`, {
        signal: ac.signal,
      });
      assert.equal(sseRes.status, 200, 'SSE stream opens');
      const reader = sseRes.body.getReader();
      const post = await fetch(`${BASE}${api}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bitpype-webinar-session': session },
        body: JSON.stringify({ body: 'SSE hello from the visitor' }),
      });
      assert.equal(post.status, 200, 'visitor post while live');
      let sseText = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !sseText.includes('SSE hello from the visitor')) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('sse read timeout')), 6000)),
        ]);
        if (done) break;
        sseText += new TextDecoder().decode(value);
      }
      ac.abort();
      assert.ok(sseText.includes('SSE hello from the visitor'), 'SSE delivered the visitor message');

      const hostPost = await jarA.post(`/api/v1/portal/modules/webinar/${wA.id}/messages`, {
        body: 'Host reply from the portal',
      });
      assert.equal(hostPost.status, 200, 'host posts from the portal console');
      const msgs = await asJson(
        await fetch(`${BASE}${api}/messages`, { headers: { 'x-bitpype-webinar-session': session } })
      );
      const hostMsg = msgs.messages.find((m) => m.body === 'Host reply from the portal');
      assert.ok(hostMsg && hostMsg.isHost, 'host message badged for visitors');
      const visitorMsg = msgs.messages.find((m) => m.body === 'SSE hello from the visitor');
      const hide = await jarA.post(`/api/v1/portal/modules/webinar/${wA.id}/messages/${visitorMsg.id}/hide`, { hidden: true });
      assert.equal(hide.status, 200, 'owner hides a message');
      const after = await asJson(
        await fetch(`${BASE}${api}/messages`, { headers: { 'x-bitpype-webinar-session': session } })
      );
      assert.ok(!after.messages.some((m) => m.id === visitorMsg.id), 'hidden message gone for visitors');
      const ownerMsgs = (await asJson(await jarA.get(`/api/v1/portal/modules/webinar/${wA.id}/messages`))).data;
      assert.ok(ownerMsgs.messages.some((m) => m.id === visitorMsg.id && m.hidden), 'owner console still shows it hidden');
      n += 9;
    }

    // Registrant list over HTTP.
    {
      const regs = (await asJson(await jarA.get(`/api/v1/portal/modules/webinar/${wA.id}/registrations`))).data;
      assert.ok(regs.registrations.some((r) => r.email === 'vic165@example.invalid'), 'registrant listed for the owner');
      n += 1;
    }

    // Gate lockout: fresh webinar, 10 bad codes then 429.
    {
      const w3 = await (
        await jarA.post('/api/v1/portal/modules/webinar', {
          title: 'Lockout Drill',
          scheduledAt: '2026-12-07T19:00',
        })
      ).json();
      const api3 = `/api/v1/modules/public/webinar/${tokenA}/${w3.data.item.slug}`;
      let lastStatus = 0;
      for (let i = 0; i < 11; i++) {
        const r = await fetch(`${BASE}${api3}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Lock', email: 'lock165@example.invalid', phone: '6105550100', code: 'AAAAAAA' }),
        });
        lastStatus = r.status;
        await r.text();
      }
      assert.equal(lastStatus, 429, 'gate locks out after repeated bad codes');
      n += 1;
      ctx.w3 = w3.data.item;
    }

    // Platform (163) surface smoke: gate page + brand untouched.
    {
      const jar = makeJar(BASE);
      const page = await jar.get(`/webinar/${platformW.slug}`);
      const html = await page.text();
      assert.equal(page.status, 200, 'platform gate page 200');
      assert.ok(html.includes('BitPype Webinar'), 'platform brand intact');
      const enter = await jar.post(
        `/webinar/${platformW.slug}/enter`,
        { name: 'Plat Vic', email: 'plat165@example.invalid', phone: '6105550130', code: platformW.accessCode },
        { form: true }
      );
      assert.equal(enter.status, 303, 'platform enter redirects to the room');
      const room = await jar.get(`/webinar/${platformW.slug}`);
      const roomHtml = await room.text();
      assert.ok(roomHtml.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'platform room embeds the video');
      n += 4;
    }

    // Detach B's module: its public surface closes.
    {
      const det = await jarB.post('/api/v1/portal/modules/webinar/detach', {});
      assert.equal(det.status, 200, 'B detaches the module');
      const gone = await fetch(`${BASE}/api/v1/modules/public/webinar/${tokenB}/list`);
      assert.equal(gone.status, 404, 'detached module token no longer resolves');
      n += 2;
    }

    group('Part 3 HTTP end-to-end', n);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/* ================================================================== */
/* Part 4 — standalone travel + single-site clone boot                 */
/* ================================================================== */
async function part4(ctx) {
  let n = 0;
  const { platformW, wA } = ctx;
  const backup = require(path.join(root, 'server', 'standaloneBackup.js'));
  const workDir = path.join(temp, 'standalone165');
  fs.mkdirSync(workDir, { recursive: true });
  const gen = await backup.generateStandaloneBackup({ workspaceId: WS, websiteId: SITE_A, workDir });
  const pkg = gen.packageDir;
  assert.ok(pkg && fs.existsSync(pkg), 'standalone package generated');

  const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
  const seedDb = new Database(path.join(pkg, 'seed', 'platform.sqlite'), { readonly: true });
  const seedWebinars = seedDb.prepare('SELECT id, lead_id, slug FROM webinars').all();
  assert.ok(seedWebinars.some((w) => Number(w.id) === wA.id), 'site webinar travels in the seed');
  assert.ok(!seedWebinars.some((w) => Number(w.id) === platformW.id), 'platform webinar NEVER travels');
  assert.ok(seedWebinars.every((w) => w.lead_id != null), 'every seeded webinar is site-scoped');
  const seedRegs = seedDb.prepare('SELECT webinar_id FROM webinar_registrations').all();
  assert.ok(seedRegs.some((r) => Number(r.webinar_id) === wA.id), 'site registrations travel');
  assert.ok(!seedRegs.some((r) => Number(r.webinar_id) === platformW.id), 'platform registrations never travel');
  seedDb.close();
  n += 5;

  assert.ok(
    fs.existsSync(path.join(pkg, 'site', 'webinar', `${wA.slug}.html`)),
    'baked package ships the webinar gate/room shell'
  );
  assert.ok(fs.existsSync(path.join(pkg, 'site', 'js', 'webinar-embed.js')), 'baked package ships the webinar client');
  n += 2;
  group('Part 4a standalone travel', n);

  // Clone boot against the suite's own fixture data (one workspace,
  // lead A's site + lead B's site in the same tenant db — the clone
  // scope resolves to the FIRST website, lead A). The clone must
  // serve A's gate/room and 404 the platform webinar.
  n = 0;
  const CLONE_PORT = 33166;
  const CBASE = `http://127.0.0.1:${CLONE_PORT}`;
  const child = spawnServer({ BITPYPE_SINGLE_SITE: '1' }, CLONE_PORT);
  let errBuf = '';
  child.stderr.on('data', (d) => (errBuf += d));
  try {
    const ready = await waitReady(CLONE_PORT, child);
    assert.ok(ready, 'clone server became ready. stderr tail: ' + errBuf.slice(-400));
    const jar = makeJar(CBASE);
    const gate = await jar.get(`/webinar/${wA.slug}`);
    const gateHtml = await gate.text();
    assert.equal(gate.status, 200, 'clone serves the site gate');
    assert.ok(gateHtml.includes(wA.title), 'clone gate names the site webinar');
    assert.ok(!gateHtml.includes('BitPype Webinar'), 'clone gate is not platform-branded');
    const enter = await jar.post(
      `/webinar/${wA.slug}/enter`,
      { name: 'Clone Vic', email: 'clone165@example.invalid', phone: '6105550177', code: ctx.codeA },
      { form: true }
    );
    assert.equal(enter.status, 303, 'clone enter redirects to the room');
    const room = await jar.get(`/webinar/${wA.slug}`);
    const roomHtml = await room.text();
    assert.equal(room.status, 200, 'clone room 200');
    assert.ok(roomHtml.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'clone room embeds the video');
    const plat = await jar.get(`/webinar/${platformW.slug}`);
    assert.equal(plat.status, 404, 'platform webinar 404s on the clone');
    n += 7;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  group('Part 4b clone-mode routes', n);
}

/* ================================================================== */
(async () => {
  const started = Date.now();
  try {
    part1();
    await fixtures();
    const ctx = await part2();
    await part3(ctx);
    await part4(ctx);
    console.log(`batch165 webinar-module: PASS — ${groups.length} groups in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const g of groups) console.log('  - ' + g);
    process.exit(0);
  } catch (e) {
    console.error('batch165 webinar-module: FAIL —', e && e.message);
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
  }
})();
