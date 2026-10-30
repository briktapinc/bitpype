'use strict';
/**
 * Batch 82 — member Logout link in the site top nav (Ely, 2026-10-30:
 * "you can add it there [the top nav], just in case"). The members page
 * card already had a working Log out button; a signed-in member browsing
 * the rest of the site had none. This batch mirrors a Log out link into
 * the top nav next to the Members link — belt and braces, reusing the
 * EXACT members-page logout mechanism (same POST route, same session
 * clearing), never a parallel one.
 *
 *   Part A — source pins: module-embed.js carries the nav wiring
 *     (data-bp-member-nav-logout, gated on a stored session) and BOTH
 *     logout call sites (members-page button + nav link) POST to
 *     '/members/logout' with pre-captured session headers; the public
 *     route still funnels to publicMemberLogout → logoutMember (the
 *     session-row delete); MODULE_SCRIPT_VER bumped to mod21.
 *   Part B — sync behavior on fixture sites (in-process): while a
 *     members embed is active, sync guarantees the module loader on
 *     EVERY page (nav section when it has chrome, else a flagged
 *     carrier section, else the freeform body); the members nav anchor
 *     carries data-bitpype-module-nav="members"; a non-members control
 *     site gets NO sitewide loader; detaching members drops the
 *     carrier sections again.
 *   Part C — HTTP against the real server: login mints a session, the
 *     members payload resolves it, POST /members/logout (the route the
 *     nav link uses) kills it server-side.
 *   Part D — rendered output (Puppeteer, real engine renders + the real
 *     module-embed.js against the real server): signed OUT the nav has
 *     no logout link; signed IN it appears right after the Members item
 *     (and on a gated page whose body unlocks); clicking it POSTs the
 *     same logout route, clears localStorage, removes the link, and
 *     the gated page locks again; the members-page Log out button
 *     still works exactly as before (and also clears the nav link).
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b82-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch82', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31482;
const BASE = `http://127.0.0.1:${PORT}`;
const MARKER = 'ABOUT_SECRET_MARKER_B82';
const MEMBER_EMAIL = 'pat@fixture.test';
const MEMBER_PASSWORD = 'password123';

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
const count = (s, sub) => String(s).split(sub).length - 1;

/* ===================================================================== */
/* Part A — source pins                                                   */
/* ===================================================================== */

function partA() {
  const embed = fs.readFileSync(path.join(root, 'public/js/module-embed.js'), 'utf8');
  check('A: nav logout wiring exists and is session-gated', () => {
    assert.ok(embed.includes('data-bp-member-nav-logout'), 'logout link marker attr');
    assert.ok(embed.includes('function wireMemberNavLogout()'), 'wire function');
    assert.ok(embed.includes('function storedMemberSessionEntry()'), 'session entry reader');
    assert.ok(embed.includes('if (!entry) return;'), 'no session → nothing added');
    assert.ok(embed.includes("document.querySelectorAll('[data-bitpype-module-nav=\"members\"]')"), 'managed members anchor locator');
    assert.ok(embed.includes('function boot()'), 'boot present');
    const bootBody = embed.slice(embed.indexOf('function boot()'));
    assert.ok(bootBody.includes('wireMemberNavLogout();'), 'boot wires the nav');
  });
  check('A: BOTH logout call sites use the members-page route + flow', () => {
    assert.ok(count(embed, "'/members/logout', {}, headers") >= 2, 'page button + nav link POST the same route with pre-captured headers');
    assert.ok(embed.includes('data-bp-member-logout'), 'members-page button still present');
    assert.ok(embed.includes("saveMemberSession(entry.token, '');"), 'nav flow clears the stored session for its own token');
    assert.ok(embed.includes("textContent = 'Log out'"), 'nav link label matches the members-page wording');
  });
  check('A: public route still funnels to the one logout implementation', () => {
    const routes = fs.readFileSync(path.join(root, 'server/routes/modulesPublic.js'), 'utf8');
    assert.ok(routes.includes("router.post('/:token/members/logout'"), 'logout route mounted');
    assert.ok(routes.includes('siteModules.publicMemberLogout(db, req.params.token, session)'), 'route delegates to publicMemberLogout');
    const sm = fs.readFileSync(path.join(root, 'server/siteModules.js'), 'utf8');
    assert.ok(sm.includes('function publicMemberLogout(db, token, rawSession)'), 'publicMemberLogout defined');
    assert.ok(sm.includes('DELETE FROM site_member_sessions WHERE token_hash = ? AND lead_id = ?'), 'logout deletes the session row (unchanged)');
  });
  check('A: sitewide loader pass + carrier cleanup pinned; script version bumped', () => {
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod22', 'Batch 82 bumps the embed script version');
    const src = fs.readFileSync(path.join(root, 'server/siteModules.js'), 'utf8');
    assert.ok(src.includes("const membersActive = embeds.some((e) => e.module_type === 'members');"), 'members-active detection');
    assert.ok(src.includes('bitpype_member_nav_managed: 1'), 'carrier section flag written');
    assert.ok(src.includes('sec.content.bitpype_member_nav_managed) return membersActive;'), 'carrier dropped when members inactive');
  });
  check('A: portal keeps its own separate logout (untouched)', () => {
    const portal = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
    assert.ok(portal.includes('id="btn-logout"'), 'portal header logout predates this batch and stays');
  });
}

/* ===================================================================== */
/* Seed + Part B — sync behavior on fixture sites                         */
/* ===================================================================== */

const fixture = {};
const NAV_HTML =
  '<header class="site-head"><nav class="main-nav"><ul class="nav-row">' +
  '<li class="nav-li"><a class="nav-a" href="index.html">Home</a></li>' +
  '<li class="nav-li"><a class="nav-a" href="about.html">About</a></li>' +
  '</ul></nav></header>';
const FOOT_HTML = '<footer class="site-foot"><p>Fixture footer</p></footer>';

function sectionsSite(bodyHtml) {
  return [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'nav', content: { html: NAV_HTML } },
        { type: 'html', content: { html: `<main>${bodyHtml}</main>` } },
        { type: 'footer', content: { html: FOOT_HTML } },
      ],
    },
    {
      slug: 'about',
      title: 'About',
      sections: [
        { type: 'nav', content: { html: NAV_HTML } },
        { type: 'html', content: { html: `<main><p>${MARKER}</p></main>` } },
        { type: 'footer', content: { html: FOOT_HTML } },
      ],
    },
  ];
}

async function seed() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const platform = require(path.join(root, 'server', 'platform.js'));
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Member Nav Fixture', 'member-nav-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  fixture.wdb = wdb;

  const siteModules = require(path.join(root, 'server/siteModules.js'));
  fixture.siteModules = siteModules;
  siteModules.ensureTables(wdb);

  // Lead 1 — members site (freestyle nav chrome, the designed-site shape).
  wdb.prepare("INSERT INTO leads (id, business_name, email, status) VALUES (1, 'Fixture Members Co', 'owner@fixture.test', 'new')").run();
  wdb
    .prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (1, ?, ?, ?)')
    .run('Members Fixture Site', '{}', JSON.stringify(sectionsSite('<p>Welcome home</p>')));
  const att = siteModules.attachModule(wdb, 1, 'members', { workspaceId: 1, appUrl: BASE });
  assert.ok(att && att.embed && att.embed.public_token, 'members attach returns a token');
  fixture.membersToken = siteModules.getEmbedRow(wdb, 1, 'members').public_token;
  siteModules.updateMembersConfig(wdb, 1, { gate_mode: 'selected', gated_pages: ['about'] });
  const su = siteModules.signupMember(wdb, 1, { name: 'Pat Member', email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
  assert.ok(su.session && su.session.token, 'fixture member signed up with a session');
  fixture.memberId = su.member.id;

  // Lead 2 — control site, blog only (no members): no sitewide loader.
  wdb.prepare("INSERT INTO leads (id, business_name, email, status) VALUES (2, 'Fixture Blog Co', 'blog@fixture.test', 'new')").run();
  wdb
    .prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (2, ?, ?, ?)')
    .run('Blog Fixture Site', '{}', JSON.stringify(sectionsSite('<p>Blog home</p>')));
  siteModules.attachModule(wdb, 2, 'blog', { workspaceId: 1, appUrl: BASE });

  // Lead 3 — structured-nav site (nav section without authored chrome):
  // the loader must ride in a flagged carrier section, dropped on detach.
  wdb.prepare("INSERT INTO leads (id, business_name, email, status) VALUES (3, 'Fixture Plain Co', 'plain@fixture.test', 'new')").run();
  wdb.prepare('INSERT INTO websites (lead_id, name, theme, pages) VALUES (3, ?, ?, ?)').run(
    'Plain Fixture Site',
    '{}',
    JSON.stringify([
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'nav', content: {} },
          { type: 'html', content: { html: '<main><p>Plain home</p></main>' } },
          { type: 'footer', content: {} },
        ],
      },
    ])
  );
  siteModules.attachModule(wdb, 3, 'members', { workspaceId: 1, appUrl: BASE });
}

function storedPages(leadId) {
  const row = fixture.wdb.prepare('SELECT pages FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(leadId);
  return JSON.parse(row.pages);
}

function partB() {
  const sm = fixture.siteModules;
  check('B: members site — loader guaranteed on EVERY page after sync', () => {
    const pages = storedPages(1);
    assert.ok(pages.length >= 3, 'members page created alongside home/about');
    for (const p of pages) {
      assert.ok(JSON.stringify(p).includes('/js/module-embed.js'), `page ${p.slug} carries the module loader`);
    }
    fixture.pages1 = pages;
  });
  check('B: members nav anchor is managed (attr the client wiring keys on)', () => {
    const home = fixture.pages1.find((p) => p.slug === 'index');
    const navSec = home.sections.find((s) => s.type === 'nav');
    assert.ok(navSec.content.html.includes('data-bitpype-module-nav="members"'), 'nav carries the managed members anchor');
    assert.ok(navSec.content.html.includes('/js/module-embed.js'), 'freestyle nav section itself carries the loader');
  });
  check('B: control site without members gets NO sitewide loader', () => {
    const pages = storedPages(2);
    const home = pages.find((p) => p.slug === 'index');
    assert.ok(!JSON.stringify(home).includes('/js/module-embed.js'), 'blog-only home page has no module loader');
    const blog = pages.find((p) => p.slug === 'blog');
    assert.ok(blog && JSON.stringify(blog).includes('/js/module-embed.js'), 'the blog page itself still loads its mount script');
  });
  check('B: structured-nav site gets a flagged carrier section; detach drops it', () => {
    let pages = storedPages(3);
    let home = pages.find((p) => p.slug === 'index');
    const carrier = home.sections.find((s) => s.content && s.content.bitpype_member_nav_managed === 1);
    assert.ok(carrier, 'carrier section present while members active');
    assert.ok(carrier.content.html.includes('/js/module-embed.js'), 'carrier holds the loader tag');
    sm.detachModule(fixture.wdb, 3, 'members');
    pages = storedPages(3);
    home = pages.find((p) => p.slug === 'index');
    assert.ok(
      !home.sections.some((s) => s.content && s.content.bitpype_member_nav_managed),
      'carrier section removed after detach'
    );
  });
  check('B: server-side logout (the shared implementation) kills the session', () => {
    const li = sm.loginMember(fixture.wdb, 1, { email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
    assert.ok(li.session && li.session.token, 'login mints a session');
    assert.equal(sm.getSessionMember(fixture.wdb, 1, li.session.token).email, MEMBER_EMAIL);
    sm.publicMemberLogout(fixture.wdb, fixture.membersToken, li.session.token);
    assert.equal(sm.getSessionMember(fixture.wdb, 1, li.session.token), null, 'publicMemberLogout deletes the session');
  });
}

/* ===================================================================== */
/* Part C — HTTP against the real server                                  */
/* ===================================================================== */

async function partC(postJson, getJsonWithSession) {
  let sessionToken = '';
  await checkAsync('C: login over HTTP mints a session the payload resolves', async () => {
    const r = await postJson(`/api/v1/modules/public/${fixture.membersToken}/members/login`, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
    });
    assert.equal(r.status, 200, `login status ${r.status}: ${JSON.stringify(r.json)}`);
    sessionToken = r.json.data.session.token;
    assert.ok(sessionToken, 'session token returned');
    fixture.httpSession = sessionToken;
    const me = await getJsonWithSession(`/api/v1/modules/public/${fixture.membersToken}`, sessionToken);
    assert.equal(me.json.data.members.member.email, MEMBER_EMAIL, 'payload resolves the signed-in member');
  });
  await checkAsync('C: POST /members/logout (the nav link route) kills the session server-side', async () => {
    const r = await postJson(`/api/v1/modules/public/${fixture.membersToken}/members/logout`, {}, sessionToken);
    assert.equal(r.status, 200, `logout status ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.ok, true);
    const me = await getJsonWithSession(`/api/v1/modules/public/${fixture.membersToken}`, sessionToken);
    assert.equal(me.json.data.members.member, null, 'dead session resolves to anonymous');
    assert.equal(
      fixture.siteModules.getSessionMember(fixture.wdb, 1, sessionToken),
      null,
      'session row deleted in the workspace DB'
    );
  });
}

/* ===================================================================== */
/* Part D — rendered output (Puppeteer)                                   */
/* ===================================================================== */

async function partD(postJson) {
  const puppeteer = require('puppeteer');
  const eng = require(path.join(root, 'src/websiteEngine.js'));
  const sm = fixture.siteModules;
  const pages = storedPages(1);
  const themeRow = fixture.wdb.prepare('SELECT theme FROM websites WHERE lead_id = 1 ORDER BY id DESC LIMIT 1').get();
  const theme = JSON.parse(themeRow.theme || '{}');
  const homeHtml = eng.renderPage(pages.find((p) => p.slug === 'index'), pages, theme, {});
  const gated = sm.gateExportPages(fixture.wdb, 1, pages, { appUrl: BASE });
  const aboutHtml = eng.renderPage(gated.find((p) => p.slug === 'about'), gated, theme, {});
  const membersHtml = eng.renderPage(pages.find((p) => p.slug === 'members'), pages, theme, {});
  assert.ok(homeHtml.includes('data-bitpype-module-nav="members"'), 'rendered home nav carries the members anchor');
  assert.ok(homeHtml.includes('/js/module-embed.js'), 'rendered home page loads module-embed.js');

  const login = async () => {
    const r = await postJson(`/api/v1/modules/public/${fixture.membersToken}/members/login`, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
    });
    assert.equal(r.status, 200, `browser-flow login status ${r.status}`);
    return r.json.data.session.token;
  };
  const sessionKey = `bp_member_session_${fixture.membersToken}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', async (r) => {
      const url = r.url();
      requests.push({ method: r.method(), url });
      if (url === `${BASE}/bp82-home`) return r.respond({ status: 200, contentType: 'text/html', body: homeHtml });
      if (url === `${BASE}/bp82-about`) return r.respond({ status: 200, contentType: 'text/html', body: aboutHtml });
      if (url === `${BASE}/bp82-members`) return r.respond({ status: 200, contentType: 'text/html', body: membersHtml });
      if (url.startsWith(BASE)) return r.continue();
      // The sitewide loader tag points at the platform public origin
      // (https://bitpype.test in this fixture — the production shape, where
      // the public URL IS the app origin). Proxy those requests to the
      // spawned server so the script and its API calls really execute.
      if (url.startsWith('https://bitpype.test/')) {
        try {
          const target = BASE + url.slice('https://bitpype.test'.length);
          const init = { method: r.method(), headers: r.headers() };
          if (!['GET', 'HEAD'].includes(r.method())) init.body = r.postData() || undefined;
          const resp = await fetch(target, init);
          const body = Buffer.from(await resp.arrayBuffer());
          const headers = {};
          resp.headers.forEach((v, k) => { headers[k] = v; });
          return r.respond({ status: resp.status, headers, body });
        } catch {
          return r.abort();
        }
      }
      return r.abort();
    });
    const logoutPosts = () =>
      requests.filter((r) => r.method === 'POST' && r.url.includes(`/members/logout`)).length;

    await checkAsync('D: signed OUT — top nav has the Members link and NO logout link', async () => {
      await page.goto(`${BASE}/bp82-home`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.BitpypeModules && window.BitpypeModules.__booted, { timeout: 20000 });
      await page.waitForSelector('[data-bitpype-module-nav="members"]', { timeout: 20000 });
      assert.equal(await page.$('[data-bp-member-nav-logout]'), null, 'no logout link when signed out');
    });

    const session2 = await login();
    await checkAsync('D: signed IN — Log out appears in the top nav right after Members', async () => {
      await page.evaluate(
        (k, v) => localStorage.setItem(k, v),
        sessionKey,
        session2
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-bp-member-nav-logout]', { timeout: 20000 });
      const info = await page.evaluate(() => {
        const out = document.querySelector('[data-bp-member-nav-logout]');
        const anchor = out.tagName === 'A' ? out : out.querySelector('a');
        const members = document.querySelector('[data-bitpype-module-nav="members"]');
        const membersRow = members.tagName === 'LI' ? members : members.closest('li') || members;
        return {
          text: anchor.textContent.trim(),
          cls: anchor.getAttribute('class'),
          afterMembers: membersRow.nextElementSibling === out || members.nextElementSibling === out,
        };
      });
      assert.equal(info.text, 'Log out');
      assert.ok(info.afterMembers, 'logout sits immediately after the members nav item');
    });

    await checkAsync('D: signed IN — gated page body unlocks and its nav shows Log out too', async () => {
      await page.goto(`${BASE}/bp82-about`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((m) => document.body.innerText.includes(m), { timeout: 20000 }, MARKER);
      await page.waitForSelector('[data-bp-member-nav-logout]', { timeout: 20000 });
    });

    await checkAsync('D: clicking the nav Log out — same route, session cleared, nav back to signed-out', async () => {
      await page.goto(`${BASE}/bp82-home`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-bp-member-nav-logout]', { timeout: 20000 });
      const before = logoutPosts();
      await page.click('[data-bp-member-nav-logout] a, a[data-bp-member-nav-logout]');
      await page.waitForFunction(
        (k) => !localStorage.getItem(k),
        { timeout: 20000 },
        sessionKey
      );
      await page.waitForFunction(() => !document.querySelector('[data-bp-member-nav-logout]'), { timeout: 20000 });
      assert.ok(logoutPosts() > before, 'click POSTed the members/logout route');
      const post = requests.find((r) => r.method === 'POST' && r.url.includes('/members/logout'));
      assert.ok(
        post.url.includes(`/api/v1/modules/public/${fixture.membersToken}/members/logout`),
        'POST went to the members module logout route (same as the members page)'
      );
      assert.equal(sm.getSessionMember(fixture.wdb, 1, session2), null, 'server-side session deleted by the nav logout');
    });

    await checkAsync('D: after nav logout the gated page locks again', async () => {
      await page.goto(`${BASE}/bp82-about`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.bp-mod-gate', { timeout: 20000 });
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(!text.includes(MARKER), 'gated body is NOT served after logout');
    });

    await checkAsync('D: members-page Log out button still works (and clears the nav link)', async () => {
      const session3 = await login();
      await page.goto(`${BASE}/bp82-home`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(
        (k, v) => localStorage.setItem(k, v),
        sessionKey,
        session3
      );
      await page.goto(`${BASE}/bp82-members`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-bp-member-logout]', { timeout: 20000 });
      await page.waitForSelector('[data-bp-member-nav-logout]', { timeout: 20000 });
      const before = logoutPosts();
      await page.click('[data-bp-member-logout]');
      await page.waitForFunction(
        (k) => !localStorage.getItem(k),
        { timeout: 20000 },
        sessionKey
      );
      await page.waitForFunction(() => !document.querySelector('[data-bp-member-nav-logout]'), { timeout: 20000 });
      assert.ok(logoutPosts() > before, 'members-page button POSTed the same logout route');
      assert.equal(sm.getSessionMember(fixture.wdb, 1, session3), null, 'members-page logout still deletes the session');
    });

    check('D: no page errors from the embed script', () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
}

/* ===================================================================== */
/* Main                                                                   */
/* ===================================================================== */

(async () => {
  partA();
  await seed();
  partB();

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
    for (let n = 0; n < 300 && !ready; n++) {
      if (child.exitCode != null) throw new Error('server exited early: ' + output);
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    assert(ready, 'server did not become ready: ' + output);

    const postJson = async (p, body, session) => {
      const headers = { 'content-type': 'application/json' };
      if (session) headers['x-bitpype-member-session'] = session;
      const res = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
      return { status: res.status, json: await res.json() };
    };
    const getJsonWithSession = async (p, session) => {
      const res = await fetch(BASE + p, { headers: { 'x-bitpype-member-session': session } });
      return { status: res.status, json: await res.json() };
    };

    await partC(postJson, getJsonWithSession);
    await partD(postJson);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }

  console.log(JSON.stringify({ passed: true, checks: results.length, batch: 82 }));
  console.log(results.map((r) => '  ✓ ' + r).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
