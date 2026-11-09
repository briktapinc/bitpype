'use strict';
/**
 * Batch 164 — CUSTOM CODE module (Ely's order, 2026-11-08: "Add a
 * module for html code + js that can be placed in any section of
 * the site, so the user can add custom features — still works like
 * every other module").
 *
 * The placeable, per-instance sibling of Batch 152's site-wide code
 * fields. A `custom_code` module type (MODULE_TYPES 29 -> 30) whose
 * content is a set of BLOCKS (module_custom_code_blocks): each block
 * carries a label + html + js, mints its OWN public token, and is
 * placed by the owner into any section of any page (a module mount
 * carrying the block's token). Rendering rides the module pipeline:
 * module-embed.js fetches the public payload per token and
 * renderCustomCode sets the owner's HTML and runs the JS field in a
 * per-instance wrapper (`root` = the block's element, try/catch
 * isolated). Code executes ONLY on the public site render — never
 * in the portal/editor (the payload is fetched by the public embed
 * script; the owner's code is never inlined into any page HTML).
 *
 * Trust model = Batch 152 (owner-authored code on the owner's own
 * site, verbatim). The design agent can see the module exists
 * (registry metadata) but has NO tool that reads/writes/places its
 * contents — the allowlists deliberately omit custom_code.*.
 *
 * Pinned here:
 *   Part 1 — registration + surface pins (types/meta/script ver,
 *     Batch 122 registry parity + owner-only reason, portal UI,
 *     embed renderer, agent fence, MCP catalogs, design rules).
 *   Part 2 — block CRUD + the 100,000-char caps refused BEFORE
 *     write (stored values untouched), lead isolation.
 *   Part 3 — attach/detach/purge semantics + public payloads
 *     (block token serves code; type token dormant; detach
 *     silences blocks; delete strips mounts via the sync).
 *   Part 4 — owner placement (portal place flow), two instances on
 *     one page rendering in position through the engine, layout
 *     knobs on the instance section, static export survival, and
 *     the owner's JS never appearing inline in page HTML.
 *   Part 5 — canonical-save idempotency (Batch 149 discipline):
 *     layout save of the placed model, twice, byte-identical.
 *   Part 6 — MCP parity: hosted callTool round-trip + the local
 *     parity tools + catalog entries.
 *   Part 7 — Batch 155 standalone clone: the generated package's
 *     baked page carries the mount and its seed tenant DB carries
 *     the block row, so the clone renders the module.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b164-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch164', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 29).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const NAV_HTML = `<header class="site-head"><nav class="main-nav"><ul class="nav-menu">
<li><a href="/index">Home</a></li>
<li><a href="/about">About</a></li>
</ul></nav></header>`;
const FOOTER_HTML = `<footer class="site-footer"><p class="fine">B164 Plants — demo</p></footer>`;

function fixturePages() {
  const mk = (slug, title, mainHtml) => ({
    slug,
    title,
    sections: [
      { type: 'nav', content: { html: NAV_HTML } },
      { type: 'html', content: { html: mainHtml } },
      { type: 'footer', content: { html: FOOTER_HTML } },
    ],
  });
  return [
    mk('index', 'Home', '<main><h1>Plants for people</h1><p>Welcome to the B164 plant shop.</p></main>'),
    mk('about', 'About', '<main><h1>About</h1><p>Our story.</p></main>'),
  ];
}
const BASE_THEME = { primary: '#1d4633', secondary: '#7d9b76', bg: '#f7f1e3', text: '#1c140f' };

const HTML_A = '<div class="b164-marker-a">Marker A (static)</div>';
const JS_A = "root.querySelector('.b164-marker-a').textContent = 'Marker A (JS ran)';";
const HTML_B = '<div class="b164-marker-b">Marker B</div>';
const JS_B = "root.setAttribute('data-b164-b-ran', '1');";

async function main() {
  /* ---------------------------------------------------------------- */
  /* Part 1 — registration + surface pins                              */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const sm = require(path.join(root, 'server/siteModules.js'));
    assert.equal(sm.MODULE_TYPES.length, 31, 'MODULE_TYPES at 30 with custom_code');
    n++;
    assert.equal(sm.MODULE_TYPES[29], 'custom_code', 'custom_code appended last');
    n++;
    assert.equal(sm.MODULE_META.custom_code.label, 'Custom Code', 'portal label is Custom Code');
    n++;
    assert.equal(sm.MODULE_SCRIPT_VER, 'mod41', 'embed script version bumped for renderCustomCode');
    n++;
    const share = require(path.join(root, 'server/moduleShare.js'));
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'Batch 122 registry parity: one entry per module type'
    );
    n++;
    const reg = share.SHARE_REGISTRY.custom_code;
    assert.equal(reg.kind, 'none', 'custom_code honestly shares nothing (kind none)');
    n++;
    assert.ok(/owner/i.test(reg.reason) && /never/i.test(reg.reason), 'registry reason states the owner-only rule');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes("{ type: 'custom_code', label: 'Custom Code' }"), 'portal module list carries custom_code');
    n++;
    assert.ok(portalJs.includes("'pricing', 'custom_code'"), 'portal Content nav group carries custom_code');
    n++;
    assert.ok(portalJs.includes('function renderCustomCodePanel()'), 'portal has the Custom Code panel renderer');
    n++;
    assert.ok(portalJs.includes('JavaScript — code only'), 'portal JS field is labelled code-only (152 convention)');
    n++;
    assert.ok(read('public/portal.html').includes('id="modules-customcode-panel"'), 'portal.html carries the panel host');
    n++;
    const icons = read('public/js/moduleIcons.js');
    assert.ok(/custom_code:/.test(icons), 'module icon glyph registered');
    n++;

    const embed = read('public/js/module-embed.js');
    assert.ok(embed.includes('function renderCustomCode(el, data, prefixHtml)'), 'embed renderer exists');
    n++;
    assert.ok(embed.includes("type === 'custom_code'"), 'embed dispatch routes custom_code before the empty check');
    n++;
    assert.ok(embed.includes("new Function('root', 'el', ownerJs)"), 'JS field runs in the per-instance wrapper with root = element');
    n++;

    // The agent fence: NO custom_code tool in either allowlist, and
    // the mode gate refuses them in every mode.
    const agent = require(path.join(root, 'server/museAgentTools.js'));
    for (const name of ['custom_code.list', 'custom_code.create', 'custom_code.update', 'custom_code.delete']) {
      assert.ok(!agent.PORTAL_READONLY_TOOLS.has(name), `${name} not in the agent read allowlist`);
      n++;
      assert.ok(!agent.PORTAL_DESIGN_WRITE_TOOLS.has(name), `${name} not in the agent write allowlist`);
      n++;
      assert.equal(agent.portalModeAllowsTool('build', name), false, `${name} refused in build mode`);
      n++;
      assert.equal(agent.portalModeAllowsTool('answer', name), false, `${name} refused in answer mode`);
      n++;
    }
    // The owner-only rule lives in the shared-layer registry metadata
    // (asserted above) and in the allowlist comments — NOT in the
    // default design instructions: the website seed already sits at
    // 19,957 of the 20,000-char cap (Batch 153), so no paragraph fits.
    const seeds = require(path.join(root, 'src', 'defaultDesignInstructions.js'));
    assert.ok(seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS.length <= 20000, 'design instructions seed stays within the 20,000-char cap');
    n++;
    // The structure insert refuses the TYPE token for every caller —
    // instances are placed from the Modules tab only.
    const psc = read('server/portalSiteChat.js');
    assert.ok(psc.includes("if (type === 'custom_code')"), 'ensureModuleTokenForInsert refuses custom_code');
    n++;
    assert.ok(psc.includes("m.type !== 'custom_code'"), 'layout ADD palette excludes the dormant type entry');
    n++;

    // MCP parity surfaces carry the family.
    const catalog = read('src/mcpCatalog.js');
    for (const name of ['custom_code.list', 'custom_code.create', 'custom_code.update', 'custom_code.delete']) {
      assert.ok(catalog.includes(`name: '${name}'`), `local catalog carries ${name}`);
      n++;
    }
    const hosted = read('server/mcp.js');
    for (const name of ['custom_code.list', 'custom_code.create', 'custom_code.update', 'custom_code.delete']) {
      assert.ok(hosted.includes(`name: '${name}'`), `hosted MCP catalog carries ${name}`);
      n++;
      assert.ok(hosted.includes(`'${name}'`), `hosted MCP entitlement list carries ${name}`);
      n++;
      assert.ok(hosted.includes(`name === '${name}'`), `hosted MCP handler carries ${name}`);
      n++;
    }
    const parity = read('src/mcpParityTools.js');
    assert.ok(parity.includes("'custom_code.create': parityEntry"), 'local parity tools implement custom_code.create');
    n++;
    assert.ok(parity.includes('createCustomCodeBlock(db, leadId, { ...args }, { workspaceId })'), 'parity create injects workspaceId for the token mint');
    n++;
    group('Part 1 registration + surface pins', n);
  }

  /* ---------------------------------------------------------------- */
  /* Seed                                                              */
  /* ---------------------------------------------------------------- */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a164@example.invalid',
    password: ['batch164', 'test', 'pw', 'value'].join('-'),
    name: 'A164',
    workspaceName: 'Batch164 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a164@example.invalid' });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);

  const LEAD_A = 916401;
  const LEAD_B = 916402;
  for (const [id, name] of [
    [LEAD_A, 'B164 Victoria Plants'],
    [LEAD_B, 'B164 Other Blooms'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      `lead${id}@example.invalid`,
      'customer'
    );
  }
  const SITE_A = Number(
    db
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(LEAD_A, 'B164 Site', 'draft', JSON.stringify(fixturePages()), JSON.stringify(BASE_THEME))
      .lastInsertRowid
  );
  const storedPages = () => JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = ?').get(SITE_A).pages);

  /* ---------------------------------------------------------------- */
  /* Part 2 — block CRUD + caps                                        */
  /* ---------------------------------------------------------------- */
  let blockA;
  let blockB;
  {
    let n = 0;
    blockA = sm.createCustomCodeBlock(db, LEAD_A, { label: 'Marker A', html: HTML_A, js: JS_A }, { workspaceId: WS_ID });
    assert.ok(blockA.id > 0, 'block created with an id');
    n++;
    assert.match(blockA.public_token, new RegExp(`^${WS_ID}_[A-Za-z0-9_-]+$`), 'block mints its own workspace-scoped token');
    n++;
    blockB = sm.createCustomCodeBlock(db, LEAD_A, { label: 'Marker B', html: HTML_B, js: JS_B }, { workspaceId: WS_ID });
    assert.notEqual(blockA.public_token, blockB.public_token, 'each instance has its own token');
    n++;
    assert.deepEqual(
      sm.listCustomCodeBlocks(db, LEAD_A).map((b) => b.id),
      [blockA.id, blockB.id],
      'blocks list in creation order'
    );
    n++;
    assert.equal(sm.getCustomCodeBlock(db, LEAD_A, blockA.id).js, JS_A, 'code stored verbatim (no sanitisation)');
    n++;
    assert.equal(sm.moduleItemCount(db, LEAD_A, 'custom_code'), 2, 'tab badge counts blocks');
    n++;

    const updated = sm.updateCustomCodeBlock(db, LEAD_A, blockA.id, { label: 'Marker A v2' });
    assert.equal(updated.label, 'Marker A v2', 'label updates');
    n++;
    assert.equal(updated.html, HTML_A, 'untouched fields survive a partial update');
    n++;
    sm.updateCustomCodeBlock(db, LEAD_A, blockA.id, { label: 'Marker A' });

    // Caps: refused BEFORE write, stored values untouched (152 rule).
    const big = 'x'.repeat(sm.CUSTOM_CODE_FIELD_MAX_CHARS + 1);
    assert.throws(
      () => sm.updateCustomCodeBlock(db, LEAD_A, blockA.id, { html: big }),
      (e) => e.code === 'CODE_TOO_LARGE',
      'over-cap HTML refused with CODE_TOO_LARGE'
    );
    n++;
    assert.equal(sm.getCustomCodeBlock(db, LEAD_A, blockA.id).html, HTML_A, 'stored HTML untouched after the refused write');
    n++;
    assert.throws(
      () => sm.createCustomCodeBlock(db, LEAD_A, { js: big }, { workspaceId: WS_ID }),
      (e) => e.code === 'CODE_TOO_LARGE',
      'over-cap JS refused on create'
    );
    n++;
    assert.equal(sm.listCustomCodeBlocks(db, LEAD_A).length, 2, 'no partial row from the refused create');
    n++;
    const atCap = sm.createCustomCodeBlock(
      db,
      LEAD_A,
      { label: 'At cap', html: 'y'.repeat(sm.CUSTOM_CODE_FIELD_MAX_CHARS), js: '' },
      { workspaceId: WS_ID }
    );
    assert.equal(atCap.html.length, sm.CUSTOM_CODE_FIELD_MAX_CHARS, 'exactly-at-cap saves');
    n++;
    sm.deleteCustomCodeBlock(db, LEAD_A, atCap.id);
    assert.equal(sm.listCustomCodeBlocks(db, LEAD_A).length, 2, 'at-cap block deleted again');
    n++;

    // Lead isolation.
    assert.throws(() => sm.getCustomCodeBlock(db, LEAD_B, blockA.id), (e) => e.code === 'NOT_FOUND', 'other lead cannot read the block');
    n++;
    assert.throws(
      () => sm.updateCustomCodeBlock(db, LEAD_B, blockA.id, { html: 'pwned' }),
      (e) => e.code === 'NOT_FOUND',
      'other lead cannot write the block'
    );
    n++;
    assert.equal(sm.listCustomCodeBlocks(db, LEAD_B).length, 0, 'other lead sees no blocks');
    n++;
    group('Part 2 block CRUD + caps + isolation', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 3 — attach / detach / payload semantics                      */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const pagesBefore = JSON.stringify(storedPages());
    const attached = sm.attachModule(db, LEAD_A, 'custom_code', { workspaceId: WS_ID });
    assert.ok(attached.embed && attached.embed.published, 'attach publishes the type embed');
    n++;
    assert.equal(JSON.stringify(storedPages()), pagesBefore, 'attach injects NOTHING — custom_code has no page of its own');
    n++;
    const typeToken = attached.embed.public_token;

    const dormant = sm.getPublicModuleByToken(db, typeToken);
    assert.equal(dormant.module_type, 'custom_code', 'type token resolves as custom_code');
    n++;
    assert.equal(dormant.custom_code, null, 'type token payload is dormant (no block behind it)');
    n++;
    assert.deepEqual(dormant.items, [], 'type token payload carries no items');
    n++;

    const payload = sm.getPublicModuleByToken(db, blockA.public_token);
    assert.equal(payload.module_type, 'custom_code', 'block token resolves as custom_code');
    n++;
    assert.equal(payload.custom_code.id, blockA.id, 'payload names the block');
    n++;
    assert.equal(payload.custom_code.html, HTML_A, 'payload carries the HTML verbatim');
    n++;
    assert.equal(payload.custom_code.js, JS_A, 'payload carries the JS verbatim');
    n++;

    sm.detachModule(db, LEAD_A, 'custom_code');
    assert.throws(
      () => sm.getPublicModuleByToken(db, blockA.public_token),
      (e) => e.code === 'NOT_FOUND',
      'detach silences every block at once'
    );
    n++;
    sm.attachModule(db, LEAD_A, 'custom_code', { workspaceId: WS_ID });
    assert.equal(sm.getPublicModuleByToken(db, blockA.public_token).custom_code.id, blockA.id, 're-attach restores serving');
    n++;
    group('Part 3 attach/detach/payload', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 4 — placement, render, knobs, export                         */
  /* ---------------------------------------------------------------- */
  const portalModules = require(path.join(root, 'server/portalModules.js'));
  const psc = require(path.join(root, 'server/portalSiteChat.js'));
  {
    let n = 0;
    const placedA = await portalModules.placeCustomCodeBlock(WS_ID, LEAD_A, blockA.id, { slug: 'index' }, 'a164@example.invalid');
    assert.equal(placedA.placed, true, 'owner place flow places block A');
    n++;
    const placedB = await portalModules.placeCustomCodeBlock(WS_ID, LEAD_A, blockB.id, { slug: 'index' }, 'a164@example.invalid');
    assert.equal(placedB.placed, true, 'owner place flow places block B');
    n++;
    await assert.rejects(
      () => portalModules.placeCustomCodeBlock(WS_ID, LEAD_A, blockA.id, { slug: 'index' }, 'a164@example.invalid'),
      (e) => e.code === 'VALIDATION',
      'placing the same block on the same page twice is refused with guidance'
    );
    n++;

    const pages = storedPages();
    const index = pages.find((p) => p.slug === 'index');
    const mounts = index.sections.filter((s) => s.content && s.content.module_type === 'custom_code');
    assert.equal(mounts.length, 2, 'two instance sections on the home page');
    n++;
    assert.deepEqual(
      mounts.map((s) => s.content.public_token),
      [blockA.public_token, blockB.public_token],
      'instances sit in placement order, before the footer'
    );
    n++;
    assert.equal(index.sections[index.sections.length - 1].type, 'footer', 'footer stays last');
    n++;

    // Public render through the engine: mounts in position, the
    // embed runtime referenced, and the owner's code NOT inlined
    // (it is fetched per token by module-embed.js at view time).
    const html = engine.renderPage(index, pages, BASE_THEME, {});
    const posA = html.indexOf(blockA.public_token);
    const posB = html.indexOf(blockB.public_token);
    assert.ok(posA > -1 && posB > -1, 'both instance tokens render on the page');
    n++;
    assert.ok(posA < posB, 'instances render in section order');
    n++;
    assert.ok(html.includes('data-bitpype-module-type="custom_code"'), 'mounts carry the custom_code type marker');
    n++;
    assert.ok(html.includes('module-embed.js'), 'the module embed runtime ships with the page');
    n++;
    assert.ok(!html.includes(JS_A) && !html.includes('b164-marker-a'), 'owner code is never inlined into page HTML (no portal/editor execution surface)');
    n++;

    // Layout editor: instance tokens resolve to the type; the ADD
    // palette omits the dormant type entry.
    const ed = psc.getClientLayoutEditor(WS_ID, LEAD_A, 'index');
    assert.equal(ed.tokens[blockA.public_token], 'custom_code', 'layout editor resolves instance token A');
    n++;
    assert.equal(ed.tokens[blockB.public_token], 'custom_code', 'layout editor resolves instance token B');
    n++;
    assert.ok(!ed.palette.modules.some((m) => m.type === 'custom_code'), 'layout ADD palette excludes custom_code (blocks are placed from the Modules tab)');
    n++;

    // Layout knobs on the instance section (Batch 148 path).
    const knobbed = JSON.parse(JSON.stringify(ed.sections));
    const aSection = knobbed.find((s) => s.content && s.content.public_token === blockA.public_token);
    aSection.width = 'full';
    aSection.hideOnMobile = true;
    await psc.applyClientLayoutSave(WS_ID, LEAD_A, { slug: 'index', sections: knobbed });
    const pages2 = storedPages();
    const index2 = pages2.find((p) => p.slug === 'index');
    const stored2 = index2.sections.find((s) => s.content && s.content.public_token === blockA.public_token);
    assert.equal(stored2.width, 'full', 'width knob stored on the instance section');
    n++;
    assert.equal(stored2.hideOnMobile, true, 'hide-on-mobile knob stored on the instance section');
    n++;
    const html2 = engine.renderPage(index2, pages2, BASE_THEME, {});
    const aPos = html2.indexOf(blockA.public_token);
    // Batch 148 decorates the section ROOT (the ws-html-block wrapper
    // div around the mount) with the knob classes.
    const wrapPos = html2.lastIndexOf('ws-html-block', aPos);
    const wrapTag = html2.slice(html2.lastIndexOf('<div', wrapPos), html2.indexOf('>', wrapPos));
    assert.ok(wrapTag.includes('bp-sec-full'), 'rendered instance section carries the full-width knob class');
    n++;
    assert.ok(wrapTag.includes('bp-sec-nomobile'), 'rendered instance section carries the hide-on-mobile knob class');
    n++;

    // Static export survival: the exported page carries the mounts
    // and the runtime — this is the path the old freestyle route
    // failed; the module pipeline carries it.
    const outDir = path.join(temp, 'export');
    engine.exportStatic(db, SITE_A, outDir);
    const exported = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(exported.includes(blockA.public_token) && exported.includes(blockB.public_token), 'exported page carries both instance mounts');
    n++;
    assert.ok(exported.includes('module-embed.js'), 'exported page references the module runtime');
    n++;
    assert.ok(!exported.includes(JS_A), 'exported page does not inline the owner JS either');
    n++;

    // Detach is a real off switch for placed blocks too; re-attach
    // heals the mounts (the sections keep their block tokens).
    sm.detachModule(db, LEAD_A, 'custom_code');
    const offPages = storedPages();
    const offIndex = offPages.find((p) => p.slug === 'index');
    const offHtml = engine.renderPage(offIndex, offPages, BASE_THEME, {});
    assert.ok(!offHtml.includes(blockA.public_token), 'detached: block A mount is stripped from the render');
    n++;
    assert.ok(!offHtml.includes(blockB.public_token), 'detached: block B mount is stripped from the render');
    n++;
    assert.ok(
      offIndex.sections.some((s) => s.content && s.content.public_token === blockA.public_token),
      'detached: the section keeps its block token (placement survives)'
    );
    n++;
    sm.attachModule(db, LEAD_A, 'custom_code', { workspaceId: WS_ID });
    const onPages = storedPages();
    const onIndex = onPages.find((p) => p.slug === 'index');
    const onHtml = engine.renderPage(onIndex, onPages, BASE_THEME, {});
    assert.ok(onHtml.includes(blockA.public_token), 're-attached: block A mount is healed');
    n++;
    assert.ok(onHtml.includes(blockB.public_token), 're-attached: block B mount is healed');
    n++;
    group('Part 4 placement + render + knobs + export', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 5 — canonical-save idempotency (Batch 149 discipline)        */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const before = JSON.stringify(storedPages());
    const ed = psc.getClientLayoutEditor(WS_ID, LEAD_A, 'index');
    await psc.applyClientLayoutSave(WS_ID, LEAD_A, { slug: 'index', sections: JSON.parse(JSON.stringify(ed.sections)) });
    const after1 = JSON.stringify(storedPages());
    const ed2 = psc.getClientLayoutEditor(WS_ID, LEAD_A, 'index');
    await psc.applyClientLayoutSave(WS_ID, LEAD_A, { slug: 'index', sections: JSON.parse(JSON.stringify(ed2.sections)) });
    const after2 = JSON.stringify(storedPages());
    // The one first-save delta the platform applies to EVERY module
    // section (not custom-code-specific): the canonical save appends
    // the managed module-embed script tag to the section HTML.
    // Removing exactly those tags must reproduce the pre-save model.
    const stripManagedTag = (json) => {
      const pages = JSON.parse(json);
      for (const p of pages) {
        for (const s of p.sections || []) {
          if (s && s.content && typeof s.content.html === 'string') {
            s.content.html = s.content.html.replace(/\n?<script src="[^"]*module-embed\.js[^"]*"[^>]*><\/script>/g, '');
          }
        }
      }
      return JSON.stringify(pages);
    };
    assert.equal(stripManagedTag(after1), stripManagedTag(before), 'first canonical save delta is only the managed script tag');
    n++;
    assert.equal(after2, after1, 'repeated layout saves of the unchanged model are byte-identical (Batch 149)');
    n++;
    group('Part 5 save idempotency', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 6 — MCP parity round-trip                                    */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const mcp = require(path.join(root, 'server/mcp.js'));
    const created = await mcp.callTool(WS_ID, 'custom_code.create', { leadId: LEAD_A, label: 'MCP block', html: '<p>mcp</p>', js: '' }, {});
    const mcpBlock = (created.data && created.data.custom_code) || created.custom_code || created;
    assert.ok(mcpBlock && mcpBlock.id > 0, 'hosted MCP creates a block');
    n++;
    assert.match(mcpBlock.public_token, new RegExp(`^${WS_ID}_`), 'hosted MCP block mints its token in the workspace');
    n++;
    const listed = await mcp.callTool(WS_ID, 'custom_code.list', { leadId: LEAD_A }, {});
    const listArr = (listed.data && listed.data.custom_code) || listed.custom_code || listed;
    assert.ok(Array.isArray(listArr) && listArr.some((b) => b.id === mcpBlock.id), 'hosted MCP lists the block');
    n++;
    const upd = await mcp.callTool(WS_ID, 'custom_code.update', { leadId: LEAD_A, id: mcpBlock.id, label: 'MCP block v2' }, {});
    assert.equal(((upd.data && upd.data.custom_code) || upd.custom_code || upd).label, 'MCP block v2', 'hosted MCP updates the block');
    n++;
    await mcp.callTool(WS_ID, 'custom_code.delete', { leadId: LEAD_A, id: mcpBlock.id }, {});
    assert.ok(!sm.listCustomCodeBlocks(db, LEAD_A).some((b) => b.id === mcpBlock.id), 'hosted MCP deletes the block');
    n++;
    group('Part 6 MCP parity (hosted callTool)', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 7 — standalone clone travel (Batch 155)                      */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const backup = require(path.join(root, 'server/standaloneBackup.js'));
    const genDir = path.join(temp, 'gen');
    fs.mkdirSync(genDir, { recursive: true });
    const gen = await backup.generateStandaloneBackup({ workspaceId: WS_ID, websiteId: SITE_A, workDir: genDir });
    const pkg = gen.packageDir;
    const baked = fs.readFileSync(path.join(pkg, 'site', 'index.html'), 'utf8');
    assert.ok(baked.includes(blockA.public_token), 'clone package baked page carries the instance mount');
    n++;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const tenant = new Database(path.join(pkg, 'seed', 'tenant.sqlite'), { readonly: true });
    const row = tenant
      .prepare('SELECT label, html, js FROM module_custom_code_blocks WHERE public_token = ?')
      .get(blockA.public_token);
    tenant.close();
    assert.ok(row, 'clone seed tenant DB carries the block row');
    n++;
    assert.equal(row.html, HTML_A, 'clone carries the block HTML');
    n++;
    assert.equal(row.js, JS_A, 'clone carries the block JS');
    n++;
    group('Part 7 standalone clone travel', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 8 — delete cascades                                          */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    sm.deleteCustomCodeBlock(db, LEAD_A, blockB.id);
    const pages = storedPages();
    const index = pages.find((p) => p.slug === 'index');
    assert.ok(
      !index.sections.some((s) => s.content && s.content.public_token === blockB.public_token),
      'deleting a block strips its mounts on the next sync'
    );
    n++;
    assert.ok(
      index.sections.some((s) => s.content && s.content.public_token === blockA.public_token),
      'the surviving block keeps its mount'
    );
    n++;
    const res = sm.deleteModule(db, LEAD_A, 'custom_code');
    assert.ok(res.deleted, 'module delete runs');
    n++;
    assert.equal(sm.listCustomCodeBlocks(db, LEAD_A).length, 0, 'module delete purges its blocks');
    n++;
    assert.throws(
      () => sm.getPublicModuleByToken(db, blockA.public_token),
      (e) => e.code === 'NOT_FOUND',
      'no payload serves after module delete'
    );
    n++;
    group('Part 8 delete cascades', n);
  }

  console.log(`\nBATCH164 SUITE: ${groups.length} groups — ALL PASS`);
  console.log(groups.map((g) => `  · ${g}`).join('\n'));
}

main().catch((e) => {
  console.error('BATCH164 FAIL:', e);
  process.exit(1);
});
