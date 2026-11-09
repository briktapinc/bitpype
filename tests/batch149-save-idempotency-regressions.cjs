'use strict';
/**
 * Batch 149 — SAVE-PATH IDEMPOTENCY (Ely's order 2026-11-05, after the
 * Batch 147 live proof exposed the drift): saving an UNCHANGED page
 * model through the canonical path (domain.sitesSave -> engine.saveSite
 * + the module/nav/chatbot syncs that ride it) must store byte-identical
 * bytes on every save.
 *
 * Root causes fixed:
 *   1. The managed-script ensures — ensureModuleEmbedScript
 *      (server/siteModules.js), ensureChatEmbedScript (server/chatbot.js),
 *      ensureFormEmbedScript (server/contactForms.js) and the members
 *      ensureSitewideScript — were four copies of "strip own tag,
 *      append \n + tag". The strip left the separator newline behind
 *      (+1 newline per call; the 147 proof measured +2/save), and when
 *      several families share one html blob (module + chat on a shop
 *      page, form + chat on a contact page) each ensure removed its
 *      tag from the middle of the trailing script cluster and
 *      re-appended it at the end — the cluster shuffled every save and
 *      separators accumulated without bound. ALL FOUR now delegate to
 *      the one canonical fixed-point ensure,
 *      src/managedScripts.ensureManagedScript, which collects every
 *      family's tag (siblings verbatim), strips clusters WITH their
 *      separators, and rebuilds in canonical family order.
 *   2. domain.sitesSave ran its pre-save nav sync with NO module
 *      context, so that pass rebuilt the chrome without the managed
 *      module markers (data-bitpype-module-nav) and the post-save
 *      module sync rebuilt them back — saveSite's per-page updatedAt
 *      stamp therefore saw a "change" on every save and the stored
 *      pages never reached a fixed point even when the HTML did. The
 *      context computation now lives in ONE helper
 *      (siteModules.moduleNavContext) used by both passes.
 *   3. rebuildFreeformPrimaryNav (nav + footer rebuild): the replaced
 *      span ran from the first anchor's start to the last anchor's end,
 *      but the generated chunk wraps each link in a fresh <li> — the
 *      first item's <li> and the last item's </li> sat OUTSIDE the span
 *      and survived every rebuild, nesting +1 empty <li> per save in
 *      the footer Explore list. The span now expands to the wrapping
 *      <li> of each edge item (itemRange, via the existing liWrapping).
 *
 *   Part 1 — source pins for the four fixes.
 *   Part 2 — pure fixed points: ensure functions (clean / drifted /
 *     </body> form) and syncFreeformNavOrder (clean + pre-drifted).
 *   Part 3 — REAL SAVE PATH, Victoria-shaped sections site with an
 *     ecommerce mount + sitewide chatbot: sitesSave x5 feeding the
 *     stored model back unchanged; stored bytes identical from save 1
 *     to save 5; artifacts present exactly once throughout.
 *   Part 4 — PRE-DRIFTED site through the real save path (extra
 *     newlines + nested <li> shells baked into the stored model, the
 *     shape live sites already carry): stable from the first post-fix
 *     save; artifacts intact.
 *   Part 5 — attach/detach integrity: idempotency must not break the
 *     legitimate injections. Fresh site: no module -> no artifacts;
 *     attach -> first save injects mount + script + nav link; detach
 *     -> next save strips them; bytes stable in each steady state.
 *   Part 6 — layout-editor save path (applyClientLayoutSave, Batch
 *     147) shares sitesSave: a no-change layout save followed by
 *     classic saves stays on the same bytes.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b149-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch149', 'test', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------------ */
/* Victoria-shaped fixture (freestyle modular chrome, like website 40) */
/* ------------------------------------------------------------------ */
const NAV_HTML = `<header class="site-head"><nav class="main-nav"><ul class="nav-menu">
<li><a href="/index">Home</a></li>
<li><a href="/shop">Shop</a></li>
<li><a href="/about">About</a></li>
<li><a href="/contact">Contact</a></li>
</ul></nav></header>`;
const FOOTER_HTML = `<footer class="site-footer"><div class="foot-grid"><div><h4>Explore</h4><ul class="foot-links">
<li><a href="/index">Home</a></li>
<li><a href="/shop">Shop</a></li>
<li><a href="/about">About</a></li>
<li><a href="/contact">Contact</a></li>
</ul></div><p class="fine">B149 Plants — demo</p></div></footer>`;

function victoriaPages() {
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
    mk('/', 'Home', '<main><h1>Plants for people</h1><p>Welcome to the B149 plant shop.</p></main>'),
    mk('shop', 'Shop', '<main><h1>Shop</h1><p>Browse the collection.</p></main>'),
    mk('about', 'About', '<main><h1>About</h1><p>A small studio greenhouse.</p></main>'),
    mk('contact', 'Contact', '<main><h1>Contact</h1><p>Write to us.</p></main>'),
  ];
}
const THEME = { primary: '#0e7a68', secondary: '#6d4ea3', bg: '#fffaf4', text: '#1c140f' };

const count = (s, re) => (String(s).match(re) || []).length;

/* ================================================================== */
async function main() {
  /* ---------------------------------------------------------------- */
  /* Part 1 — source pins                                              */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const msSrc = read('src/managedScripts.js');
    assert.ok(msSrc.includes('function ensureManagedScript'), 'canonical managed-script ensure exists');
    n++;
    assert.ok(msSrc.includes('ensureManagedScript, LOADERS'), 'canonical ensure is exported');
    n++;
    const smSrc = read('server/siteModules.js');
    assert.ok(
      smSrc.includes("ensureManagedScript(html, 'module-embed.js', tag)"),
      'ensureModuleEmbedScript delegates to the canonical ensure'
    );
    n++;
    assert.ok(smSrc.includes('const itemRange = (r) => {'), 'nav/footer rebuild expands the span to <li> shells');
    n++;
    assert.ok(smSrc.includes('pageAnchors.map((a) => itemRange(a).start)'), 'span starts use item ranges');
    n++;
    const chatSrc = read('server/chatbot.js');
    assert.ok(
      chatSrc.includes("ensureManagedScript(html, 'chat-embed.js', tag)"),
      'ensureChatEmbedScript delegates to the canonical ensure'
    );
    n++;
    const domSrc = read('server/domain.js');
    assert.ok(smSrc.includes('function moduleNavContext'), 'shared module nav context helper exists');
    n++;
    assert.ok(smSrc.includes('moduleNavContext,'), 'moduleNavContext is exported');
    n++;
    assert.ok(domSrc.includes('moduleNavContext(db, existingSite.lead_id, pages)'), 'sitesSave passes the module context');
    n++;
    const cfSrc = read('server/contactForms.js');
    assert.ok(
      cfSrc.includes("ensureManagedScript(html, 'form-embed.js', tag)"),
      'ensureFormEmbedScript delegates to the canonical ensure'
    );
    n++;
    group('Part 1 — source pins', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 2 — pure fixed points                                        */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const sm = require(path.join(root, 'server/siteModules.js'));
    const chat = require(path.join(root, 'server/chatbot.js'));
    const structure = require(path.join(root, 'src/siteStructure.js'));
    const BASE = 'https://bitpype.com';
    const modTag = `<script src="${BASE}/js/module-embed.js?v=mod41" defer data-bitpype-module-script="1"></script>`;

    // ensureModuleEmbedScript: clean blob.
    const blob = '<main><div class="bitpype-module-embed" data-bitpype-module-token="1_x"></div></main>';
    let b1 = sm.ensureModuleEmbedScript(blob, BASE);
    assert.ok(b1.endsWith(modTag), 'ensure appends the script tag');
    n++;
    for (let i = 0; i < 4; i++) {
      const next = sm.ensureModuleEmbedScript(b1, BASE);
      assert.equal(next, b1, `ensure is a fixed point (pass ${i + 2})`);
      b1 = next;
    }
    n += 4;

    // ensureModuleEmbedScript: pre-drifted blob (newline run before tag).
    const drifted = '<main><p>x</p></main>' + '\n'.repeat(6) + modTag;
    const d1 = sm.ensureModuleEmbedScript(drifted, BASE);
    assert.equal(sm.ensureModuleEmbedScript(d1, BASE), d1, 'drifted blob stable after the first post-fix ensure');
    n++;
    assert.equal(count(d1, /module-embed\.js/g), 1, 'drifted blob still carries exactly one script tag');
    n++;

    // ensureModuleEmbedScript: </body> form, clean and drifted.
    const bodyForm = '<html><body><main>x</main></body></html>';
    const f1 = sm.ensureModuleEmbedScript(bodyForm, BASE);
    assert.equal(sm.ensureModuleEmbedScript(f1, BASE), f1, '</body> form is a fixed point');
    n++;
    const bodyDrift = '<html><body><main>x</main>' + modTag + '\n\n\n</body></html>';
    const fd1 = sm.ensureModuleEmbedScript(bodyDrift, BASE);
    assert.equal(sm.ensureModuleEmbedScript(fd1, BASE), fd1, 'drifted </body> form stable after first ensure');
    n++;
    assert.equal(count(fd1, /module-embed\.js/g), 1, 'drifted </body> form carries exactly one tag');
    n++;

    // ensureChatEmbedScript: clean + drifted fixed points.
    assert.equal(typeof chat.ensureChatEmbedScript, 'function', 'ensureChatEmbedScript exported for the suite');
    n++;
    const chatTag = (chat.chatScriptTag && chat.chatScriptTag(BASE)) || '';
    let c1 = chat.ensureChatEmbedScript('<footer>x</footer>', BASE);
    assert.equal(chat.ensureChatEmbedScript(c1, BASE), c1, 'chat ensure is a fixed point');
    n++;
    if (chatTag) {
      const chatDrift = '<footer>x</footer>' + '\n'.repeat(5) + chatTag;
      const cd1 = chat.ensureChatEmbedScript(chatDrift, BASE);
      assert.equal(chat.ensureChatEmbedScript(cd1, BASE), cd1, 'drifted chat blob stable after first ensure');
      n++;
    }

    // Multi-family cluster: module + chat + form ensures interleaved
    // over ONE blob (the shop/contact page shape) must reach a fixed
    // point — the pre-149 copies shuffled the trailing script cluster
    // and grew separator newlines on every pass.
    const cf = require(path.join(root, 'server/contactForms.js'));
    assert.equal(typeof cf.ensureFormEmbedScript, 'function', 'ensureFormEmbedScript exported for the suite');
    n++;
    let shared = '<main><p>shared blob</p></main>';
    const round = (h) =>
      chat.ensureChatEmbedScript(sm.ensureModuleEmbedScript(cf.ensureFormEmbedScript(h, BASE), BASE), BASE);
    shared = round(shared);
    const round1 = shared;
    for (let i = 0; i < 4; i++) {
      shared = round(shared);
      assert.equal(shared, round1, `multi-family cluster is a fixed point (round ${i + 2})`);
    }
    n += 4;
    assert.equal(count(shared, /module-embed\.js/g), 1, 'cluster holds exactly one module tag');
    n++;
    assert.equal(count(shared, /chat-embed\.js/g), 1, 'cluster holds exactly one chat tag');
    n++;
    assert.equal(count(shared, /form-embed\.js/g), 1, 'cluster holds exactly one form tag');
    n++;
    assert.ok(!/\n\n+<script/.test(shared), 'cluster carries no separator drift');
    n++;

    // syncFreeformNavOrder: clean Victoria-shaped pages — byte-stable
    // from the first pass; no nested <li> shells ever appear.
    let pages = victoriaPages();
    let prev = null;
    for (let i = 0; i < 5; i++) {
      pages = structure.syncFreeformNavOrder(pages, {
        activeModules: [{ type: 'ecommerce', slug: 'shop', label: 'Shop' }],
      });
      const s = JSON.stringify(pages);
      if (prev !== null) assert.equal(s, prev, `nav sync byte-stable (pass ${i + 1})`);
      prev = s;
    }
    n += 4;
    const foot = pages[0].sections.find((x) => x.type === 'footer').content.html;
    assert.ok(!/<li>\s*<li>/.test(foot), 'footer never grows nested <li> shells');
    n++;
    assert.equal(count(foot, /<li[\s>]/g), 4, 'footer Explore list keeps exactly its 4 items');
    n++;

    // syncFreeformNavOrder: pre-drifted footer (nested shells, the
    // shape the pre-149 bug left on live sites) — no growth, stable
    // from the first post-fix pass.
    const driftFooter = FOOTER_HTML.replace(
      '<li><a href="/index">Home</a></li>',
      '<li><li><li><a href="/index">Home</a></li>'
    ).replace(
      '<li><a href="/contact">Contact</a></li>',
      '<li><a href="/contact">Contact</a></li></li></li>'
    );
    let dpages = victoriaPages();
    dpages = dpages.map((p) => ({
      ...p,
      sections: p.sections.map((s) => (s.type === 'footer' ? { ...s, content: { html: driftFooter } } : s)),
    }));
    let dprev = null;
    for (let i = 0; i < 5; i++) {
      dpages = structure.syncFreeformNavOrder(dpages, {
        activeModules: [{ type: 'ecommerce', slug: 'shop', label: 'Shop' }],
      });
      const s = JSON.stringify(dpages);
      if (dprev !== null) assert.equal(s, dprev, `drifted nav sync byte-stable (pass ${i + 1})`);
      dprev = s;
    }
    n += 4;
    group('Part 2 — pure fixed points', n);
  }

  /* ---------------------------------------------------------------- */
  /* Setup for Parts 3–6 — fixture workspace + tenant db               */
  /* ---------------------------------------------------------------- */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const portal = require(path.join(root, 'server/clientPortal.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a149@example.invalid',
    password: ['batch149', 'test', 'password', 'value'].join('-'),
    name: 'A149',
    workspaceName: 'Batch149 WS',
  });
  const WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);

  const LEAD_A = 914901; // Victoria-shaped, modules attached
  const LEAD_B = 914902; // pre-drifted stored model
  const LEAD_C = 914903; // attach/detach integrity
  for (const [id, name] of [
    [LEAD_A, 'B149 Victoria Plants'],
    [LEAD_B, 'B149 Drifted Plants'],
    [LEAD_C, 'B149 Plain Plants'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      `lead${id}@example.invalid`,
      'customer'
    );
  }
  const insertSite = (leadId, pages) => {
    const info = db
      .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
      .run(leadId, `Site ${leadId}`, 'draft', JSON.stringify(pages), JSON.stringify(THEME));
    return Number(info.lastInsertRowid);
  };
  const storedPagesRaw = (siteId) => db.prepare('SELECT pages FROM websites WHERE id = ?').get(siteId).pages;
  // One canonical save, exactly as the classic editor performs it: the
  // stored model is loaded, then saved back through domain.sitesSave.
  const saveUnchanged = (siteId) => {
    const current = JSON.parse(storedPagesRaw(siteId));
    domain.sitesSave(WS_ID, siteId, { pages: current, theme: THEME });
    return storedPagesRaw(siteId);
  };

  /* ---------------------------------------------------------------- */
  /* Part 3 — real save path: attached site, 5 unchanged saves         */
  /* ---------------------------------------------------------------- */
  const SITE_A = insertSite(LEAD_A, victoriaPages());
  {
    let n = 0;
    sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID });
    sm.attachModule(db, LEAD_A, 'chatbot', { workspaceId: WS_ID });
    const attached = storedPagesRaw(SITE_A);
    assert.ok(attached.includes('bitpype-module-embed'), 'ecommerce mount present after attach');
    n++;
    assert.ok(attached.includes('module-embed.js'), 'module script present after attach');
    n++;
    assert.ok(attached.includes('data-bitpype-chat'), 'chatbot block present after attach');
    n++;

    const seq = [];
    for (let i = 0; i < 5; i++) seq.push(saveUnchanged(SITE_A));
    for (let i = 1; i < seq.length; i++) {
      assert.equal(seq[i], seq[i - 1], `stored bytes identical: save ${i} == save ${i + 1}`);
    }
    n += 4;
    const finalPages = seq[seq.length - 1];
    assert.equal(count(finalPages, /\/js\/module-embed\.js/g), count(finalPages, /bitpype-module-embed/g) > 0 ? count(finalPages, /\/js\/module-embed\.js/g) : 0, 'module script count self-consistent');
    n++;
    // Exactly one module script tag per page that hosts one, and the
    // newline run before any end-of-blob tag never exceeds one.
    const parsed = JSON.parse(finalPages);
    for (const p of parsed) {
      for (const s of p.sections || []) {
        const html = (s.content && s.content.html) || '';
        assert.ok(!/\n\n+<script[^>]*module-embed/.test(html), `no newline drift before module script (${p.slug}/${s.type})`);
        assert.ok(!/<li>\s*<li>/.test(html), `no nested <li> shells (${p.slug}/${s.type})`);
      }
    }
    n += 2;
    const homeFoot = parsed[0].sections.find((x) => x.type === 'footer').content.html;
    assert.equal(count(homeFoot, /<li[\s>]/g), 4, 'footer Explore list still has exactly 4 items after 5 saves');
    n++;
    group('Part 3 — real save path, attached site x5', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 4 — pre-drifted stored model through the real save path      */
  /* ---------------------------------------------------------------- */
  const SITE_B = insertSite(LEAD_B, victoriaPages());
  {
    let n = 0;
    const emb = sm.attachModule(db, LEAD_B, 'ecommerce', { workspaceId: WS_ID }).embed;
    const token = emb.public_token;
    // Bake the pre-149 drift into the stored model, as live sites
    // already carry it: newline runs before the module script tag and
    // nested <li> shells around the footer Explore list.
    const drifted = JSON.parse(storedPagesRaw(SITE_B));
    for (const p of drifted) {
      for (const s of p.sections || []) {
        if (!s.content || typeof s.content.html !== 'string') continue;
        if (s.content.html.includes('module-embed.js')) {
          s.content.html = s.content.html.replace(/(<script[^>]*module-embed\.js)/, '\n\n\n\n$1');
        }
        if (s.type === 'footer') {
          s.content.html = s.content.html
            .replace('<li><a href="/index">Home</a></li>', '<li><li><li><a href="/index">Home</a></li>')
            .replace('<li><a href="/contact">Contact</a></li>', '<li><a href="/contact">Contact</a></li></li></li>');
        }
      }
    }
    db.prepare('UPDATE websites SET pages = ? WHERE id = ?').run(JSON.stringify(drifted), SITE_B);
    assert.ok(storedPagesRaw(SITE_B).includes(token), 'drift fixture carries the module token');
    n++;

    const seq = [];
    for (let i = 0; i < 5; i++) seq.push(saveUnchanged(SITE_B));
    for (let i = 1; i < seq.length; i++) {
      assert.equal(seq[i], seq[i - 1], `drifted site: stored bytes identical, save ${i} == save ${i + 1}`);
    }
    n += 4;
    assert.ok(seq[4].includes(token), 'module token survives 5 saves on the drifted site');
    n++;
    assert.ok(seq[4].includes('bitpype-module-embed'), 'module mount survives 5 saves on the drifted site');
    n++;
    group('Part 4 — pre-drifted site through the real save path', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 5 — attach/detach integrity on the real save path            */
  /* ---------------------------------------------------------------- */
  const SITE_C = insertSite(LEAD_C, victoriaPages());
  {
    let n = 0;
    // No module: saves are stable and inject nothing.
    const plain1 = saveUnchanged(SITE_C);
    const plain2 = saveUnchanged(SITE_C);
    assert.equal(plain2, plain1, 'module-free site: unchanged saves are byte-identical');
    n++;
    assert.ok(!plain1.includes('module-embed.js'), 'module-free site gains no module script');
    n++;
    assert.ok(!plain1.includes('data-bitpype-module-nav'), 'module-free site gains no managed nav links');
    n++;

    // Attach: the FIRST save after attach carries the injection.
    sm.attachModule(db, LEAD_C, 'blog', { workspaceId: WS_ID });
    const withBlog = saveUnchanged(SITE_C);
    assert.ok(withBlog.includes('bitpype-module-embed'), 'attach + save: blog mount injected');
    n++;
    assert.ok(withBlog.includes('module-embed.js'), 'attach + save: module script injected');
    n++;
    const withBlog2 = saveUnchanged(SITE_C);
    const withBlog3 = saveUnchanged(SITE_C);
    assert.equal(withBlog2, withBlog, 'attached steady state: save 2 == save 1');
    n++;
    assert.equal(withBlog3, withBlog2, 'attached steady state: save 3 == save 2');
    n++;

    // Detach: the next save strips mount + script + managed nav, then
    // the site is byte-stable again.
    sm.detachModule(db, LEAD_C, 'blog');
    const stripped1 = saveUnchanged(SITE_C);
    assert.ok(!stripped1.includes('data-bitpype-module-nav="blog"'), 'detach + save: managed blog nav link removed');
    n++;
    const stripped2 = saveUnchanged(SITE_C);
    assert.equal(stripped2, stripped1, 'detached steady state: bytes stable');
    n++;
    group('Part 5 — attach/detach integrity', n);
  }

  /* ---------------------------------------------------------------- */
  /* Part 6 — layout-editor save path shares the fixed point           */
  /* ---------------------------------------------------------------- */
  {
    let n = 0;
    const ed = portal.getClientLayoutEditor(WS_ID, LEAD_A, '/');
    const sections = JSON.parse(JSON.stringify(ed.sections));
    portal.applyClientLayoutSave(WS_ID, LEAD_A, { slug: '/', sections });
    const afterLayout = storedPagesRaw(SITE_A);
    const afterClassic = saveUnchanged(SITE_A);
    assert.equal(afterClassic, afterLayout, 'classic save after a no-change layout save stores identical bytes');
    n++;
    const afterClassic2 = saveUnchanged(SITE_A);
    assert.equal(afterClassic2, afterClassic, 'bytes remain stable after the cross-path save');
    n++;
    group('Part 6 — layout-editor save path', n);
  }

  console.log(`\nbatch149 save-idempotency: ALL PASS — ${groups.join('; ')}`);
}

main().catch((e) => {
  console.error('batch149 save-idempotency: FAIL');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
