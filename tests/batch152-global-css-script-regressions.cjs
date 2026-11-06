'use strict';
/**
 * Batch 152 — GLOBAL CSS + SCRIPT (owner-facing). Ely's order
 * 2026-11-06 ("Add the ability to add a global script or CSS styling
 * to the site" → "CSS" → "Script too."): the client portal's theme
 * bar gains three owner-editable code fields, saved through the
 * EXISTING portal theme POST (applyClientThemeColors):
 *
 *   - Custom CSS   → theme.customCss (engine emits it in every page's
 *                    CSS, before the Batch 135 spacing guard)
 *   - Global script→ theme.customJs (engine wraps the raw code in a
 *                    <script data-ws-theme-js="1"> tag before </body>)
 *   - Head code    → theme.customHead (engine emits it raw, marked
 *                    <!--data-ws-theme-head-->, before </head>)
 *
 * Before this batch the portal theme bar edited colors + fonts only;
 * the fields existed solely on the staff/MCP website.setTheme path.
 *
 * Pinned here:
 *   Part 1 — source pins (UI fields, save wiring, server handling).
 *   Part 2 — styleRules.splitManagedBlock / reattachManagedBlock are
 *     exact inverses with a byte fixed point.
 *   Part 3 — portal round-trip: set all three fields → the portal
 *     GET (renderClientSite) returns them → a rendered page carries
 *     the CSS marker, the JS marker before </body>, the head marker
 *     before </head>, and the spacing guard still lands AFTER the
 *     owner's CSS.
 *   Part 4 — the managed chat-rules block survives an owner CSS save
 *     byte-for-byte and stays invisible in the owner's editable text.
 *   Part 5 — saving the returned values unchanged is byte-identical
 *     (Batch 149 idempotency through the new path).
 *   Part 6 — sanitization PARITY with the setTheme path: identical
 *     payloads via portal and via domain.sitesSetTheme store
 *     identical bytes; sanitizer-stripped content does not survive.
 *   Part 7 — per-field 100,000-char cap: over-cap refused with
 *     CODE_TOO_LARGE and the stored theme untouched; at-cap saves.
 *   Part 8 — field isolation: colors-only / CSS-only / script-only /
 *     head-only saves each leave the other fields untouched.
 *   Part 9 — tenant scoping: another workspace cannot read or write
 *     this site's code fields; the /site/theme route keeps its
 *     session-match 403 guard.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b152-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch152', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

const NAV_HTML = `<header class="site-head"><nav class="main-nav"><ul class="nav-menu">
<li><a href="/index">Home</a></li>
<li><a href="/shop">Shop</a></li>
</ul></nav></header>`;
const FOOTER_HTML = `<footer class="site-footer"><div class="foot-grid"><div><h4>Explore</h4><ul class="foot-links">
<li><a href="/index">Home</a></li>
<li><a href="/shop">Shop</a></li>
</ul></div><p class="fine">B152 Plants — demo</p></div></footer>`;

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
    mk('/', 'Home', '<main><h1>Plants for people</h1><p>Welcome to the B152 plant shop.</p></main>'),
    mk('shop', 'Shop', '<main><h1>Shop</h1><p>Browse the collection.</p></main>'),
  ];
}
const BASE_THEME = { primary: '#0e7a68', secondary: '#6d4ea3', bg: '#fffaf4', text: '#1c140f' };

const CSS_MARKER = '.b152-marker { color: #123456; }';
const JS_MARKER = "window.__b152 = 'script-marker';";
const HEAD_MARKER = '<meta name="b152-head" content="head-marker">';

async function main() {
  /* ---------------------------------------------------------------- */
  /* Part 1 — source pins                                              */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const html = read('public/portal.html');
    for (const id of ['theme-custom-css', 'theme-custom-js', 'theme-custom-head']) {
      assert.ok(html.includes(`id="${id}"`), `portal.html carries the ${id} textarea`);
      n++;
      assert.ok(html.includes(`id="${id}-count"`), `portal.html carries the ${id} character count`);
      n++;
    }
    assert.ok(html.includes('Global script'), 'script field is labelled Global script');
    n++;
    assert.ok(html.includes('Head code'), 'head field is labelled Head code');
    n++;
    assert.ok(html.includes('Custom CSS'), 'css field is labelled Custom CSS');
    n++;
    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes('CODE_FIELD_IDS'), 'portal.js wires the code fields');
    n++;
    assert.ok(portalJs.includes('...codeFields'), 'theme save POST spreads only the edited code fields');
    n++;
    assert.ok(portalJs.includes('function readCodeFields'), 'portal.js diffs code fields against saved values');
    n++;
    const edits = read('server/portalSiteEdits.js');
    assert.ok(edits.includes('PORTAL_CODE_FIELD_MAX_CHARS = 100000'), 'portal code-field cap is 100,000 chars');
    n++;
    assert.ok(edits.includes("code: 'CODE_TOO_LARGE'"), 'over-cap refusal carries CODE_TOO_LARGE');
    n++;
    assert.ok(edits.includes('splitManagedBlock'), 'portal path splits the managed block');
    n++;
    assert.ok(edits.includes('reattachManagedBlock'), 'portal path reattaches the managed block');
    n++;
    const routes = read('server/routes/portal.js');
    assert.ok(routes.includes("code === 'CODE_TOO_LARGE'"), 'route maps CODE_TOO_LARGE to a 400');
    n++;
    const sr = require(path.join(root, 'server/styleRules.js'));
    assert.equal(typeof sr.splitManagedBlock, 'function', 'splitManagedBlock exported');
    n++;
    assert.equal(typeof sr.reattachManagedBlock, 'function', 'reattachManagedBlock exported');
    n++;
    group('Part 1 — source pins', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 2 — split / reattach are exact inverses                      */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const sr = require(path.join(root, 'server/styleRules.js'));
    const withRule = sr.upsertStyleRule('.a { color: #111111; }', {
      selector: 'h3',
      property: 'color',
      value: '#444444',
    });
    const split1 = sr.splitManagedBlock(withRule);
    assert.ok(split1.managedBlock.startsWith(sr.BLOCK_START), 'managed block extracted with its start marker');
    n++;
    assert.ok(split1.managedBlock.endsWith(sr.BLOCK_END), 'managed block extracted with its end marker');
    n++;
    assert.equal(split1.editable, '.a { color: #111111; }', 'editable portion is the owner CSS only');
    n++;
    assert.ok(!split1.editable.includes('bitpype:chat-rules'), 'editable portion hides the managed markers');
    n++;
    const rejoined = sr.reattachManagedBlock(split1.editable, split1.managedBlock);
    assert.equal(rejoined, withRule, 'reattach restores the exact stored bytes');
    n++;
    const split2 = sr.splitManagedBlock(rejoined);
    assert.deepEqual(split2, split1, 'split after reattach is a fixed point');
    n++;
    assert.equal(
      sr.reattachManagedBlock(split2.editable, split2.managedBlock),
      rejoined,
      'a second owner save of unchanged CSS is byte-identical'
    );
    n++;
    const plain = '.b { margin: 0; }';
    assert.deepEqual(sr.splitManagedBlock(plain), { editable: plain, managedBlock: '' }, 'no block → all editable');
    n++;
    assert.equal(sr.reattachManagedBlock(plain, ''), plain, 'no block → reattach is a passthrough');
    n++;
    // Block in the middle: both sides survive as editable text.
    const mid = `.x { top: 0; }\n${split1.managedBlock}\n.y { bottom: 0; }`;
    const splitMid = sr.splitManagedBlock(mid);
    assert.ok(splitMid.editable.includes('.x { top: 0; }'), 'CSS before the block stays editable');
    n++;
    assert.ok(splitMid.editable.includes('.y { bottom: 0; }'), 'CSS after the block stays editable');
    n++;
    assert.equal(splitMid.managedBlock, split1.managedBlock, 'mid-stylesheet block extracted byte-for-byte');
    n++;
    group('Part 2 — managed block split/reattach', n);
  }

  /* ---------------------------------------------------------------- */
  /* Setup — fixture workspace + tenant db                             */
  /* ---------------------------------------------------------------- */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));
  const styleRules = require(path.join(root, 'server/styleRules.js'));
  const portal = require(path.join(root, 'server/clientPortal.js'));
  const PW = ['batch152', 'test', 'pw', 'value'].join('-');

  const a = await workspace.createUserWithWorkspace({
    email: 'a152@example.invalid',
    password: PW,
    name: 'A152',
    workspaceName: 'Batch152 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);

  const b = await workspace.createUserWithWorkspace({
    email: 'b152@example.invalid',
    password: PW,
    name: 'B152',
    workspaceName: 'Batch152 Other WS',
  });
  const WS2_ID = Number(b.workspaceId);
  const db2 = openWorkspaceDb(WS2_ID);

  const LEAD_A = 915201; // round-trip + managed block + isolation saves
  const LEAD_B = 915202; // sanitization parity (portal path)
  const LEAD_C = 915203; // sanitization parity (setTheme path)
  for (const [id, name] of [
    [LEAD_A, 'B152 Victoria Plants'],
    [LEAD_B, 'B152 Parity Portal'],
    [LEAD_C, 'B152 Parity Staff'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      `lead${id}@example.invalid`,
      'customer'
    );
  }
  const insertSite = (leadId) => {
    const info = db
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(leadId, `Site ${leadId}`, 'draft', JSON.stringify(fixturePages()), JSON.stringify(BASE_THEME));
    return Number(info.lastInsertRowid);
  };
  const SITE_A = insertSite(LEAD_A);
  const SITE_B = insertSite(LEAD_B);
  const SITE_C = insertSite(LEAD_C);
  const storedThemeRaw = (siteId) => db.prepare('SELECT theme FROM websites WHERE id = ?').get(siteId).theme;
  const storedTheme = (siteId) => JSON.parse(storedThemeRaw(siteId) || '{}');
  const storedPages = (siteId) => JSON.parse(db.prepare('SELECT pages FROM websites WHERE id = ?').get(siteId).pages);

  /* ---------------------------------------------------------------- */
  /* Part 3 — portal round-trip + rendered output                      */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const res = await portal.applyClientThemeColors(WS_ID, LEAD_A, {
      customCss: CSS_MARKER,
      customJs: JS_MARKER,
      customHead: HEAD_MARKER,
    });
    assert.equal(res.theme.customCss, CSS_MARKER, 'save response echoes the editable CSS');
    n++;
    assert.equal(res.theme.customJs, JS_MARKER, 'save response echoes the global script');
    n++;
    assert.equal(res.theme.customHead, HEAD_MARKER, 'save response echoes the head code');
    n++;
    const theme = storedTheme(SITE_A);
    assert.equal(theme.customCss, CSS_MARKER, 'stored theme carries the CSS');
    n++;
    assert.equal(theme.customJs, JS_MARKER, 'stored theme carries the script');
    n++;
    assert.equal(theme.customHead, HEAD_MARKER, 'stored theme carries the head code');
    n++;

    const view = portal.renderClientSite(WS_ID, LEAD_A, {});
    assert.equal(view.theme.customCss, CSS_MARKER, 'portal GET returns the editable CSS');
    n++;
    assert.equal(view.theme.customJs, JS_MARKER, 'portal GET returns the global script');
    n++;
    assert.equal(view.theme.customHead, HEAD_MARKER, 'portal GET returns the head code');
    n++;

    const pages = storedPages(SITE_A);
    const html = engine.renderPage(pages[0], pages, storedTheme(SITE_A), {});
    assert.ok(html.includes(CSS_MARKER), 'rendered page carries the owner CSS marker rule');
    n++;
    assert.ok(html.includes(`<script data-ws-theme-js="1">${JS_MARKER}</script>`), 'script emitted wrapped, as code');
    n++;
    assert.ok(html.indexOf(JS_MARKER) < html.indexOf('</body>'), 'script marker lands before </body>');
    n++;
    assert.ok(html.includes('<!--data-ws-theme-head-->'), 'head inject marker present');
    n++;
    assert.ok(html.indexOf(HEAD_MARKER) < html.indexOf('</head>'), 'head marker lands before </head>');
    n++;
    assert.ok(
      html.indexOf(CSS_MARKER) < html.indexOf('bitpype spacing guard (Batch 135)'),
      'spacing guard still appended AFTER the owner CSS'
    );
    n++;
    group('Part 3 — portal round-trip + rendered output', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 4 — managed chat-rules block preservation                    */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    await portal.applyClientStyleRule(WS_ID, LEAD_A, { selector: 'h3', property: 'color', value: '#444444' });
    const seeded = storedTheme(SITE_A).customCss;
    const seededSplit = styleRules.splitManagedBlock(seeded);
    assert.ok(seededSplit.managedBlock.length > 0, 'style rule seeded a managed block');
    n++;
    assert.ok(seeded.includes(CSS_MARKER), 'owner CSS still present beside the block');
    n++;
    const rulesBefore = styleRules.listStyleRules(seeded);
    assert.ok(
      rulesBefore.some((r) => r.selector === 'h3' && r.property === 'color' && r.value === '#444444'),
      'seeded rule listed before the owner save'
    );
    n++;

    const NEW_CSS = '.b152-owner-v2 { padding: 12px; }';
    await portal.applyClientThemeColors(WS_ID, LEAD_A, { customCss: NEW_CSS });
    const after = storedTheme(SITE_A).customCss;
    const afterSplit = styleRules.splitManagedBlock(after);
    assert.equal(afterSplit.managedBlock, seededSplit.managedBlock, 'managed block byte-for-byte after owner save');
    n++;
    assert.equal(afterSplit.editable, NEW_CSS, 'owner CSS replaced with the new text');
    n++;
    assert.deepEqual(styleRules.listStyleRules(after), rulesBefore, 'chat rule still listed after owner save');
    n++;
    const view = portal.renderClientSite(WS_ID, LEAD_A, {});
    assert.equal(view.theme.customCss, NEW_CSS, 'portal GET shows only the editable CSS');
    n++;
    assert.ok(!view.theme.customCss.includes('bitpype:chat-rules'), 'managed markers never reach the textarea');
    n++;
    group('Part 4 — managed block preservation', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 5 — unchanged re-save is byte-identical                      */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const view = portal.renderClientSite(WS_ID, LEAD_A, {});
    const beforeRaw = storedThemeRaw(SITE_A);
    await portal.applyClientThemeColors(WS_ID, LEAD_A, {
      customCss: view.theme.customCss,
      customJs: view.theme.customJs,
      customHead: view.theme.customHead,
    });
    assert.equal(storedThemeRaw(SITE_A), beforeRaw, 'theme bytes identical after an unchanged code save');
    n++;
    await portal.applyClientThemeColors(WS_ID, LEAD_A, {
      customCss: view.theme.customCss,
      customJs: view.theme.customJs,
      customHead: view.theme.customHead,
    });
    assert.equal(storedThemeRaw(SITE_A), beforeRaw, 'theme bytes identical after a second unchanged save');
    n++;
    group('Part 5 — save-unchanged idempotency', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 6 — sanitization parity with the setTheme path               */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const dirtyCss =
      '@import url("https://evil.example/x.css");\n' +
      '.b152-dirty { color: #222222; }\n' +
      '</style><script>alert(1)</script>';
    const dirtyJs = "window.__b152dirty = 1;</script><script>alert('x')</script>";
    const dirtyHead = '<meta name="b152-dirty" content="1"></head><script>alert(2)</script>';

    await portal.applyClientThemeColors(WS_ID, LEAD_B, {
      customCss: dirtyCss,
      customJs: dirtyJs,
      customHead: dirtyHead,
    });
    await domain.sitesSetTheme(WS_ID, SITE_C, {
      customCss: dirtyCss,
      customJs: dirtyJs,
      customHead: dirtyHead,
    });
    const viaPortal = storedTheme(SITE_B);
    const viaStaff = storedTheme(SITE_C);
    assert.equal(viaPortal.customCss, viaStaff.customCss, 'CSS stored identically via portal and setTheme');
    n++;
    assert.equal(viaPortal.customJs, viaStaff.customJs, 'script stored identically via portal and setTheme');
    n++;
    assert.equal(viaPortal.customHead, viaStaff.customHead, 'head stored identically via portal and setTheme');
    n++;
    assert.equal(viaPortal.customCss, engine.sanitizeCss(dirtyCss), 'stored CSS is exactly sanitizeCss output');
    n++;
    assert.equal(viaPortal.customJs, engine.sanitizeJs(dirtyJs), 'stored script is exactly sanitizeJs output');
    n++;
    assert.equal(viaPortal.customHead, engine.sanitizeHead(dirtyHead), 'stored head is exactly sanitizeHead output');
    n++;
    assert.ok(!viaPortal.customCss.includes('evil.example'), 'non-Google @import stripped');
    n++;
    assert.ok(!viaPortal.customCss.includes('</style'), 'style breakout stripped from CSS');
    n++;
    assert.ok(!viaPortal.customJs.includes('</script><script>'), 'script breakout escaped in JS');
    n++;
    assert.ok(!viaPortal.customHead.includes('</head><script>'), 'head breakout escaped in head code');
    n++;
    group('Part 6 — sanitization parity with setTheme', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 7 — per-field caps                                           */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const CAP = 100000;
    const beforeRaw = storedThemeRaw(SITE_B);
    for (const [field, label] of [
      ['customCss', 'Custom CSS'],
      ['customJs', 'Global script'],
      ['customHead', 'Head code'],
    ]) {
      let threw = null;
      try {
        await portal.applyClientThemeColors(WS_ID, LEAD_B, { [field]: 'a'.repeat(CAP + 1) });
      } catch (e) {
        threw = e;
      }
      assert.ok(threw, `over-cap ${field} is refused`);
      n++;
      assert.equal(threw.code, 'CODE_TOO_LARGE', `over-cap ${field} refusal code`);
      n++;
      assert.ok(String(threw.message).includes(label), `over-cap ${field} refusal names the field`);
      n++;
    }
    assert.equal(storedThemeRaw(SITE_B), beforeRaw, 'stored theme untouched by every over-cap refusal');
    n++;
    let typeThrew = null;
    try {
      await portal.applyClientThemeColors(WS_ID, LEAD_B, { customJs: 42 });
    } catch (e) {
      typeThrew = e;
    }
    assert.ok(typeThrew && typeThrew.code === 'INVALID_CODE_FIELD', 'non-string script refused');
    n++;
    assert.equal(storedThemeRaw(SITE_B), beforeRaw, 'stored theme untouched by the type refusal');
    n++;
    const atCap = await portal.applyClientThemeColors(WS_ID, LEAD_B, { customJs: 'a'.repeat(CAP) });
    assert.equal(atCap.theme.customJs.length, CAP, 'at-cap script saves in full');
    n++;
    group('Part 7 — per-field caps', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 8 — field isolation                                          */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const t0 = storedTheme(SITE_A);
    // Colors-only save (no code fields in the request at all).
    await portal.applyClientThemeColors(WS_ID, LEAD_A, { primary: '#0a5cff' });
    const t1 = storedTheme(SITE_A);
    assert.equal(t1.primary, '#0a5cff', 'colors-only save applied the color');
    n++;
    assert.equal(t1.customCss, t0.customCss, 'colors-only save leaves CSS untouched');
    n++;
    assert.equal(t1.customJs, t0.customJs, 'colors-only save leaves the script untouched');
    n++;
    assert.equal(t1.customHead, t0.customHead, 'colors-only save leaves head code untouched');
    n++;
    // CSS-only save.
    const CSS2 = '.b152-iso { margin: 4px; }';
    await portal.applyClientThemeColors(WS_ID, LEAD_A, { customCss: CSS2 });
    const t2 = storedTheme(SITE_A);
    assert.equal(t2.primary, '#0a5cff', 'CSS-only save leaves colors untouched');
    n++;
    assert.equal(t2.customJs, t1.customJs, 'CSS-only save leaves the script untouched');
    n++;
    assert.equal(t2.customHead, t1.customHead, 'CSS-only save leaves head code untouched');
    n++;
    const split2 = styleRules.splitManagedBlock(t2.customCss);
    assert.equal(split2.editable, CSS2, 'CSS-only save stored the new editable CSS');
    n++;
    assert.equal(split2.managedBlock, styleRules.splitManagedBlock(t1.customCss).managedBlock, 'block still intact');
    n++;
    // Script-only save.
    const JS2 = "window.__b152 = 'v2';";
    await portal.applyClientThemeColors(WS_ID, LEAD_A, { customJs: JS2 });
    const t3 = storedTheme(SITE_A);
    assert.equal(t3.customJs, JS2, 'script-only save stored the new script');
    n++;
    assert.equal(t3.customCss, t2.customCss, 'script-only save leaves CSS untouched');
    n++;
    assert.equal(t3.customHead, t2.customHead, 'script-only save leaves head code untouched');
    n++;
    assert.equal(t3.primary, '#0a5cff', 'script-only save leaves colors untouched');
    n++;
    // Head-only save.
    const HEAD2 = '<meta name="b152-head" content="v2">';
    await portal.applyClientThemeColors(WS_ID, LEAD_A, { customHead: HEAD2 });
    const t4 = storedTheme(SITE_A);
    assert.equal(t4.customHead, HEAD2, 'head-only save stored the new head code');
    n++;
    assert.equal(t4.customCss, t3.customCss, 'head-only save leaves CSS untouched');
    n++;
    assert.equal(t4.customJs, t3.customJs, 'head-only save leaves the script untouched');
    n++;
    group('Part 8 — field isolation', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 9 — tenant scoping                                           */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    assert.ok(db2.prepare('SELECT id FROM leads WHERE id = ?').get(LEAD_A) == null, 'fixture: lead A absent in WS2');
    n++;
    let readThrew = null;
    try {
      portal.renderClientSite(WS2_ID, LEAD_A, {});
    } catch (e) {
      readThrew = e;
    }
    assert.ok(readThrew && readThrew.code === 'NOT_FOUND', 'another workspace cannot read the site');
    n++;
    let writeThrew = null;
    try {
      await portal.applyClientThemeColors(WS2_ID, LEAD_A, { customCss: '.evil { color: red; }' });
    } catch (e) {
      writeThrew = e;
    }
    assert.ok(writeThrew && writeThrew.code === 'NOT_FOUND', 'another workspace cannot write the site');
    n++;
    assert.ok(!storedTheme(SITE_A).customCss.includes('.evil'), 'cross-tenant write left no trace');
    n++;
    const routes = read('server/routes/portal.js');
    const themeRoute = routes.slice(routes.indexOf("router.post('/site/theme'"));
    assert.ok(
      themeRoute.slice(0, 900).includes('clientLeadId') && themeRoute.slice(0, 900).includes('FORBIDDEN'),
      '/site/theme keeps its session-match 403 guard'
    );
    n++;
    group('Part 9 — tenant scoping', n);
  }

  console.log(`\nbatch152-global-css-script-regressions: ALL PASS — ${groups.length} groups`);
}

main().catch((e) => {
  console.error('batch152-global-css-script-regressions FAILED:', e);
  process.exit(1);
});
