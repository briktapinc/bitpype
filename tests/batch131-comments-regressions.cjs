'use strict';
/**
 * Batch 131 — the Comments module, with likes.
 *
 * What this pins:
 *   Part 1 — source pins: `comments` is a MODULE_TYPE with catalog
 *     metadata, MODULE_SCRIPT_VER mod35, an explicit NON-provider
 *     moduleShare registry entry (parity holds), the comments
 *     service module + its three tables, the LeadScout
 *     captureFromComment kind, the public routes (post / like /
 *     state), the portal moderation routes + Comments pane, the MCP
 *     + catalog + parity + agent tool surfaces, the legal clauses,
 *     the icon, the public embed renderer (textContent-only — no
 *     innerHTML anywhere in the comments renderer), and the
 *     cache-busts.
 *   Part 2 — engine (in-process): config defaults (moderation HELD
 *     by default), target validation through the shared layer
 *     (published only, drafts refused, cross-lead refused,
 *     non-provider refused, unknown page refused, page targets
 *     resolve), the comment lifecycle (held → invisible → approve →
 *     visible; reject never renders; auto-publish mode; link-heavy
 *     and fast-posting holds on auto mode), one-level threading
 *     (reply-to-reply re-parents; owner replies published + badged),
 *     LeadScout capture dedupe (one contact, one event per comment;
 *     likes capture nothing), like toggling (idempotent per visitor,
 *     counts server-side, cross-visitor accumulation, item likes and
 *     comment likes are SEPARATE stores, pending comment likable
 *     only by its author, rejected comments refuse likes, delete
 *     removes likes + re-parents replies), stored-XSS payloads
 *     carried raw in JSON (rendering safety is the embed's
 *     textContent discipline, pinned in Part 1), the public embed
 *     payloads (page-mode thread, item-mode dormant fallback —
 *     an unresolvable bpItem key returns the base payload with NO
 *     error, the Batch 130 discipline), portal list/counts/targets,
 *     purge steps, and the MCP dispatch surface.
 *   Part 3 — HTTP over the real server: portal owner session
 *     (config PUT, moderation PUT, reply POST), public payload,
 *     public comment post (state-blind response, held by default),
 *     public like toggle + state read.
 *
 * NEGATIVE hooks (source pins only):
 *   B131_NEGATIVE=no-type      comments leaves MODULE_TYPES
 *   B131_NEGATIVE=no-registry  registry drops the comments entry
 *   B131_NEGATIVE=no-service   server/comments.js hidden
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch131-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
['.env', 'app.db', 'data.db', 'leads.db', 'platform.db'].forEach((name) => {
  process.env[name.toUpperCase().replace(/\W/g, '_') + '_PATH'] = path.join(process.env.REGRESSION_TMPDIR, name);
});
// Fixture secrets are fragment-assembled, never single literals.
process.env.SESSION_SECRET = ['batch131', 'fixture', 'session', 'secret', 'value'].join('-');
// Batch 131 finisher: lengthened past the >=24-char production boot minimum (the parked header assembled only 18 chars; sibling suites carry 30+).
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';
process.env.CAPTCHA_OPTIONAL = '1';

const root = path.resolve(__dirname, '..');
const PORT = 39131;
const BASE = `http://127.0.0.1:${PORT}`;
const LEAD_A = 13101;
const LEAD_B = 13102;
const PW = ['B131', 'Portal', 'Pass', '9'].join('-') + '!';
const NEGATIVE = process.env.B131_NEGATIVE || '';
const TOK_A = 'visitor-token-alpha-0001';
const TOK_B = 'visitor-token-bravo-0002';
const TOK_C = 'visitor-token-carol-0003';

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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
    throw new Error(`non-JSON response ${res.status}: ${text.slice(0, 200)}`);
  }
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
      if (cookies.size) headers.Cookie = [...cookies.values()].join('; ');
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const raw = res.headers.get('set-cookie');
      if (raw) {
        for (const part of raw.split(/,(?=\s*[^;,=]+?=)/)) {
          const pair = part.trim().split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) cookies.set(pair.slice(0, eq), pair);
        }
      }
      return res;
    },
  };
}
const throws = (fn, pattern) => {
  try {
    fn();
  } catch (e) {
    if (pattern) assert.match(String(e.message || e), pattern);
    return e;
  }
  throw new Error('expected the call to throw');
};

(async () => {
  let db = null;
  let WS_ID = 0;

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const smSrc = read('server/siteModules.js');
    if (NEGATIVE !== 'no-type') {
      assert.ok(smSrc.includes("'comments',"), 'comments registered in MODULE_TYPES');
      n++;
    }
    assert.ok(smSrc.includes("comments: { label: 'Comments'"), 'MODULE_META carries the Comments label');
    n++;
    assert.ok(
      smSrc.includes("const MODULE_SCRIPT_VER = 'mod39'"),
      'MODULE_SCRIPT_VER bumped to mod35 (Batch 131); Batch 142 finisher rotation to mod36'
    );
    n++;
    assert.ok(smSrc.includes("type === 'comments'"), 'moduleItemCount has the comments branch');
    n++;
    assert.ok(smSrc.includes("case 'comments':"), 'modulePurgeSteps has the comments case');
    n++;

    const shareSrc = read('server/moduleShare.js');
    if (NEGATIVE !== 'no-registry') {
      assert.ok(/comments: \{\s*\n\s*kind: 'none',/.test(shareSrc), 'registry has the comments NON-provider entry');
      n++;
    }
    assert.ok(shareSrc.includes('Engagement layer, not shelf content'), 'non-provider reason recorded in the registry');
    n++;

    if (NEGATIVE !== 'no-service') {
      const svcSrc = read('server/comments.js');
      for (const table of ['module_comments', 'module_likes', 'comments_configs']) {
        assert.ok(svcSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `service creates ${table}`);
        n++;
      }
      assert.ok(
        svcSrc.includes('UNIQUE(lead_id, target_type, target_id, visitor_key)'),
        'one like per visitor per target is a database rule'
      );
      n++;
      assert.ok(svcSrc.includes('captureFromComment'), 'service rides the LeadScout comment capture');
      n++;
      assert.ok(svcSrc.includes('readProviderItems'), 'targets resolve through the shared layer');
      n++;
    }

    const pcSrc = read('server/portalContacts.js');
    assert.ok(pcSrc.includes('function captureFromComment'), 'portalContacts exports captureFromComment');
    n++;
    assert.ok(
      pcSrc.includes("kind: 'comment'") || pcSrc.includes("kind = 'comment'") || pcSrc.includes("'comment'"),
      'comment capture kind present'
    );
    n++;
    assert.ok(pcSrc.includes('comment_id'), 'leadscout_events carries the comment_id ref column');
    n++;

    const pubSrc = read('server/routes/modulesPublic.js');
    assert.ok(
      pubSrc.includes("router.post('/:token/comments', bookLimit, captcha"),
      'public comment POST rides limiter + captcha'
    );
    n++;
    assert.ok(pubSrc.includes("router.post('/:token/comments/like', bookLimit"), 'public like POST rides the limiter');
    n++;
    assert.ok(
      pubSrc.includes("router.get('/:token/comments/state', readLimit"),
      'public like-state GET rides the read limiter'
    );
    n++;
    assert.ok(
      pubSrc.includes('createPublicComment') && pubSrc.includes('togglePublicLike'),
      'routes call the token entry points'
    );
    n++;

    const portalRoutes = read('server/routes/portal.js');
    for (const route of ["'/modules/comments/config'", "'/modules/comments/:id/reply'", "'/modules/comments/:id'"]) {
      assert.ok(portalRoutes.includes(route), `portal route ${route} registered`);
      n++;
    }
    const pmSrc = read('server/portalModules.js');
    for (const fn of ['saveCommentsConfig', 'moderateComment', 'removeComment', 'replyToComment']) {
      assert.ok(pmSrc.includes(fn), `portalModules carries ${fn}`);
      n++;
    }

    const mcpSrc = read('server/mcp.js');
    for (const tool of [
      'comments.getConfig',
      'comments.updateConfig',
      'comments.list',
      'comments.moderate',
      'comments.reply',
      'comments.targets',
    ]) {
      assert.ok(mcpSrc.includes(`'${tool}'`), `MCP tool ${tool} registered`);
      n++;
    }
    const catalogSrc = read('src/mcpCatalog.js');
    assert.ok(catalogSrc.includes('comments.moderate'), 'MCP catalog mirrors the comments tools');
    n++;
    const agentSrc = read('server/museAgentTools.js');
    assert.ok(agentSrc.includes("'comments.moderate'"), 'agent mutate set carries comments.moderate');
    n++;
    assert.ok(agentSrc.includes("'comments.list'"), 'agent readonly set carries comments.list');
    n++;

    const legalSrc = read('src/siteLegal.js');
    assert.ok(
      legalSrc.includes("'comments'") && legalSrc.includes('Comments and likes'),
      'legal clauses cover comments'
    );
    n++;

    const iconsSrc = read('public/js/moduleIcons.js');
    assert.ok(iconsSrc.includes('comments:'), 'module icon registered for comments');
    n++;

    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('function renderComments'), 'embed renders the comments block');
    n++;
    assert.ok(embedSrc.includes('.bp-mod-comments'), 'embed carries the comments styles');
    n++;
    // Stored-XSS discipline: the whole comments renderer region is
    // DOM/textContent only — no innerHTML anywhere between the
    // renderer and the next top-level renderer.
    const region = embedSrc.slice(
      embedSrc.indexOf('function renderComments'),
      embedSrc.indexOf('function renderCharts')
    );
    assert.ok(region.length > 500, 'comments renderer region located');
    n++;
    assert.ok(!region.includes('innerHTML'), 'comments renderer uses NO innerHTML (textContent only)');
    n++;
    assert.ok(region.includes('textContent'), 'comments renderer paints visitor text via textContent');
    n++;
    assert.ok(embedSrc.includes('bp_visitor_token'), 'visitor token is a first-party localStorage token');
    n++;

    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes("{ type: 'comments', label: 'Comments' }"), 'portal catalog entry present');
    n++;
    assert.ok(portalJs.includes('function renderCommentsAdminPanel'), 'portal Comments pane renderer present');
    n++;
    assert.ok(portalJs.includes("'/modules/comments/config'"), 'portal pane saves config through the comments route');
    n++;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('id="modules-pane-comments"'), 'portal.html mounts the Comments pane');
    n++;
    assert.ok(portalHtml.includes('data-modules-pane="comments"'), 'portal.html carries the Comments tab button');
    n++;
    assert.ok(portalHtml.includes('portal.js?v=batch137-qualifying1'), 'portal.js cache-bust rotated');
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
  const comments = require(path.join(root, 'server/comments.js'));
  const portalModules = require(path.join(root, 'server/portalModules.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a131@example.invalid',
    password: ['B131', 'Work', 'space', 'Pw'].join('-') + '!',
    name: 'A131',
    workspaceName: 'Batch131 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a131@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B131 Alpha Blooms', 'alpha131@example.invalid'],
    [LEAD_B, 'B131 Beta Lawns', 'beta131@example.invalid'],
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
    JSON.stringify([
      { slug: 'about', title: 'About Us' },
      { slug: 'visit', title: 'Visit' },
    ]),
    '{}'
  );

  // ---- Fixtures: published + draft content on lead A ----
  const postPub = sm.createBlogPost(db, LEAD_A, {
    title: 'Monstera Care 101',
    body_html: '<p>Water weekly.</p>',
    status: 'published',
  });
  const postDraft = sm.createBlogPost(db, LEAD_A, { title: 'Secret Draft', body_html: '<p>x</p>', status: 'draft' });
  const product = sm.createProduct(db, LEAD_A, { name: 'Monstera Deliciosa', price_cents: 4200, status: 'published' });
  sm.attachModule(db, LEAD_A, 'blog', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_A, 'ecommerce', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_A, 'comments', { workspaceId: WS_ID });
  sm.attachModule(db, LEAD_B, 'comments', { workspaceId: WS_ID });
  const postSlug = postPub.slug || String(postPub.id);
  const postTarget = String(postPub.id);

  // ---- 2a: registry parity + config defaults ----
  {
    let n = 0;
    assert.ok(sm.MODULE_TYPES.includes('comments'), 'MODULE_TYPES carries comments');
    n++;
    assert.equal(sm.MODULE_TYPES.length, 29, 'comments is the 28th of 29 types on this tree (Batch 139 appended pricing)');
    n++;
    assert.equal(
      Object.keys(share.SHARE_REGISTRY).length,
      sm.MODULE_TYPES.length,
      'registry ⇔ MODULE_TYPES parity (Batch 122 gate)'
    );
    n++;
    for (const t of sm.MODULE_TYPES) assert.ok(share.SHARE_REGISTRY[t], `registry covers ${t}`);
    n++;
    assert.equal(share.SHARE_REGISTRY.comments.kind, 'none', 'comments is an explicit non-provider');
    n++;
    const cfg = comments.getCommentsConfig(db, LEAD_A);
    assert.equal(cfg.moderation_held, true, 'moderation defaults to HOLD');
    n++;
    assert.equal(cfg.allow_likes, true, 'likes default on');
    n++;
    assert.equal(cfg.allow_item_like, true, 'item likes default on');
    n++;
    assert.equal(cfg.comments_enabled, true, 'comments default on');
    n++;
    assert.equal(cfg.target_mode, 'page', 'binding defaults to page mode');
    n++;
    assert.equal(cfg.target_type, 'blog', 'item type defaults to blog');
    n++;
    const upd = comments.updateCommentsConfig(db, LEAD_A, { heading: 'Say hello', target_type: 'ecommerce' });
    assert.equal(upd.heading, 'Say hello', 'config update round-trips the heading');
    n++;
    assert.equal(upd.target_type, 'ecommerce', 'config update round-trips the target type');
    n++;
    comments.updateCommentsConfig(db, LEAD_A, { heading: 'Comments', target_type: 'blog' });
    group('Part 2a parity + config defaults', n);
  }

  // ---- 2b: target validation through the shared layer ----
  {
    let n = 0;
    const bySlug = comments.resolveTarget(db, LEAD_A, 'blog', postSlug);
    assert.equal(bySlug.target_id, postTarget, 'a slug resolves to the canonical shared-layer source_id');
    n++;
    const byId = comments.resolveTarget(db, LEAD_A, 'blog', postTarget);
    assert.equal(byId.target_id, postTarget, 'the source_id itself resolves');
    n++;
    throws(() => comments.resolveTarget(db, LEAD_A, 'blog', postDraft.slug || String(postDraft.id)), /not published/);
    n++;
    throws(() => comments.resolveTarget(db, LEAD_B, 'blog', postSlug), /not published/);
    n++;
    throws(() => comments.resolveTarget(db, LEAD_A, 'newsletter', '1'), /can't take comments/);
    n++;
    throws(() => comments.resolveTarget(db, LEAD_A, 'comments', '1'), /can't take comments/);
    n++;
    throws(() => comments.resolveTarget(db, LEAD_A, 'nope', '1'), /Unknown comment target type/);
    n++;
    const page = comments.resolveTarget(db, LEAD_A, 'page', 'about');
    assert.equal(page.target_id, 'about', 'a real page slug resolves');
    n++;
    throws(() => comments.resolveTarget(db, LEAD_A, 'page', 'no-such-page'), /Unknown page/);
    n++;
    const prod = comments.resolveTarget(db, LEAD_A, 'ecommerce', String(product.id));
    assert.equal(prod.target_type, 'ecommerce', 'products are commentable targets');
    n++;
    group('Part 2b target validation', n);
  }

  // ---- 2c: comment lifecycle + capture + threading ----
  let topComment = null;
  let ownerReply = null;
  {
    let n = 0;
    const made = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postSlug,
      author_name: 'Pat Visitor',
      author_email: 'pat@example.invalid',
      body: 'Great guide — my monstera agrees.',
      visitor_token: TOK_A,
    });
    assert.equal(made.status, 'pending', 'moderation default holds the first comment');
    n++;
    topComment = made.comment;
    assert.equal(topComment.target_id, postTarget, 'the comment stores the canonical target id');
    n++;
    let thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.equal(thread.comments.length, 0, 'a held comment is invisible publicly');
    n++;
    // LeadScout capture: one deduped contact + one event per comment.
    const contact = db.prepare('SELECT * FROM leadscout_contacts WHERE email_norm = ?').get('pat@example.invalid');
    assert.ok(contact, 'the commenter became a portal contact');
    n++;
    const evts = db.prepare("SELECT * FROM leadscout_events WHERE lead_id = ? AND kind = 'comment'").all(LEAD_A);
    assert.equal(evts.length, 1, 'one capture event for the comment');
    n++;
    assert.equal(Number(evts[0].comment_id), topComment.id, 'the event refs the comment row');
    n++;

    comments.setCommentStatus(db, LEAD_A, topComment.id, 'published');
    thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.equal(thread.comments.length, 1, 'approval makes the comment visible');
    n++;
    assert.equal(thread.comments[0].body, 'Great guide — my monstera agrees.', 'the body renders verbatim');
    n++;
    assert.ok(!('author_email' in thread.comments[0]), 'author email never ships in the public shape');
    n++;
    assert.ok(!JSON.stringify(thread).includes('pat@example.invalid'), 'no email anywhere in the public thread');
    n++;

    // Second comment, same email → same contact, second event.
    const second = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      author_name: 'Pat V.',
      author_email: 'pat@example.invalid',
      body: 'Second note from the same inbox.',
      visitor_token: TOK_A,
    });
    const contacts = db.prepare('SELECT * FROM leadscout_contacts WHERE email_norm = ?').all('pat@example.invalid');
    assert.equal(contacts.length, 1, 'capture dedupes by email — still one contact');
    n++;
    const evts2 = db.prepare("SELECT * FROM leadscout_events WHERE lead_id = ? AND kind = 'comment'").all(LEAD_A);
    assert.equal(evts2.length, 2, 'each comment still gets its own event');
    n++;
    // Reject it: never renders.
    comments.setCommentStatus(db, LEAD_A, second.comment.id, 'rejected');
    thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.equal(thread.comments.length, 1, 'a rejected comment never renders');
    n++;

    // Owner reply: published immediately, badged.
    const reply = comments.replyAsOwner(db, LEAD_A, topComment.id, { body: 'Thanks Pat — water is everything.' });
    ownerReply = reply.comment || reply;
    assert.equal(ownerReply.is_owner, true, 'owner reply is flagged');
    n++;
    assert.equal(ownerReply.status, 'published', 'owner replies publish immediately');
    n++;
    assert.equal(ownerReply.author_name, 'B131 Alpha Blooms', 'owner reply defaults to the business name');
    n++;
    thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.equal(thread.comments[0].replies.length, 1, 'the reply threads under its parent');
    n++;
    assert.equal(thread.comments[0].replies[0].is_owner, true, 'the badge flag rides the public thread');
    n++;

    // Reply to a reply re-parents to the top-level ancestor.
    const nested = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      parent_id: ownerReply.id,
      author_name: 'Sam',
      author_email: 'sam@example.invalid',
      body: 'Replying to the owner reply.',
      visitor_token: TOK_B,
    });
    assert.equal(nested.comment.parent_id, topComment.id, 'threading is one level — replies attach to the ancestor');
    n++;
    comments.setCommentStatus(db, LEAD_A, nested.comment.id, 'published');
    thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.equal(thread.comments[0].replies.length, 2, 'both replies sit at level one');
    n++;

    // Auto-publish mode + the link hold heuristic.
    comments.updateCommentsConfig(db, LEAD_A, { moderation: 'auto' });
    const auto = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      author_name: 'Jo',
      author_email: 'jo@example.invalid',
      body: 'Auto-published note.',
      visitor_token: TOK_B,
    });
    assert.equal(auto.status, 'published', 'auto mode publishes immediately');
    n++;
    const spammy = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      author_name: 'Link Larry',
      author_email: 'larry@example.invalid',
      body: 'see https://a.example and https://b.example plus www.c.example now',
      visitor_token: TOK_C,
    });
    assert.equal(spammy.status, 'pending', 'three links hold the comment even in auto mode');
    n++;
    assert.equal(spammy.held_reason, 'links', 'the hold reason is recorded, never a silent drop');
    n++;
    comments.updateCommentsConfig(db, LEAD_A, { moderation: 'held' });
    group('Part 2c lifecycle + capture + threading', n);
  }

  // ---- 2d: likes ----
  {
    let n = 0;
    const like = (token, tt, tid) =>
      comments.toggleLike(db, LEAD_A, { target_type: tt, target_id: tid, visitor_token: token });
    let r = like(TOK_A, 'blog', postSlug);
    assert.deepEqual([r.liked, r.count], [true, 1], 'first like lands with the server count');
    n++;
    r = like(TOK_A, 'blog', postTarget);
    assert.deepEqual([r.liked, r.count], [false, 0], 'toggling again removes it (idempotent per visitor)');
    n++;
    r = like(TOK_A, 'blog', postTarget);
    assert.deepEqual([r.liked, r.count], [true, 1], 'and back on');
    n++;
    r = like(TOK_B, 'blog', postTarget);
    assert.equal(r.count, 2, 'a second visitor accumulates');
    n++;
    const stA = comments.likeState(db, LEAD_A, { target_type: 'blog', target_id: postTarget, visitor_token: TOK_A });
    const stC = comments.likeState(db, LEAD_A, { target_type: 'blog', target_id: postTarget, visitor_token: TOK_C });
    assert.equal(stA.item_liked, true, 'state shows the caller their pressed button');
    n++;
    assert.equal(stC.item_liked, false, 'and an unpressed one for everyone else');
    n++;
    // Comment likes are a SEPARATE store from item likes.
    r = like(TOK_A, 'comment', String(topComment.id));
    assert.deepEqual([r.liked, r.count], [true, 1], 'liking the comment counts on the comment');
    n++;
    assert.equal(comments.likeCount(db, LEAD_A, 'blog', postTarget), 2, 'the item count did not move');
    n++;
    assert.equal(
      comments.getCommentRow(db, LEAD_A, topComment.id).like_count,
      1,
      'the comment like_count cache refreshed'
    );
    n++;
    const stWithComment = comments.likeState(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      comment_ids: [topComment.id],
      visitor_token: TOK_A,
    });
    assert.deepEqual(stWithComment.liked_comment_ids, [topComment.id], 'comment like state rides the same read');
    n++;
    // A pending comment: only its author may like it.
    const pending = comments.createComment(db, LEAD_A, {
      target_type: 'blog',
      target_id: postTarget,
      author_name: 'Holden',
      author_email: 'holden@example.invalid',
      body: 'Still in the queue.',
      visitor_token: TOK_C,
    });
    r = like(TOK_C, 'comment', String(pending.comment.id));
    assert.equal(r.liked, true, 'the author can like their own pending comment');
    n++;
    throws(() => like(TOK_A, 'comment', String(pending.comment.id)), /awaiting approval/);
    n++;
    // A rejected comment refuses likes entirely.
    const rejected = db
      .prepare("SELECT id FROM module_comments WHERE lead_id = ? AND status = 'rejected' LIMIT 1")
      .get(LEAD_A);
    throws(() => like(TOK_A, 'comment', String(rejected.id)), /no longer available/);
    n++;
    // Config gates.
    comments.updateCommentsConfig(db, LEAD_A, { allow_likes: false });
    throws(() => like(TOK_A, 'blog', postTarget), /turned off/);
    n++;
    comments.updateCommentsConfig(db, LEAD_A, { allow_likes: true, allow_item_like: false });
    throws(() => like(TOK_A, 'blog', postTarget), /Item likes are turned off/);
    n++;
    r = like(TOK_B, 'comment', String(topComment.id));
    assert.equal(r.count, 2, 'comment likes still work with item likes off');
    n++;
    comments.updateCommentsConfig(db, LEAD_A, { allow_item_like: true });
    // Visitor keys are hashes — the raw token never reaches the table.
    const likeRows = db.prepare('SELECT visitor_key FROM module_likes WHERE lead_id = ?').all(LEAD_A);
    assert.ok(likeRows.length >= 3, 'likes are stored');
    n++;
    assert.ok(
      likeRows.every((x) => /^[0-9a-f]{64}$/.test(x.visitor_key)),
      'visitor_key is a sha256 hash, never the raw token'
    );
    n++;
    // Deleting a comment removes its likes and re-parents its replies.
    comments.deleteComment(db, LEAD_A, topComment.id);
    assert.equal(
      comments.likeCount(db, LEAD_A, 'comment', String(topComment.id)),
      0,
      'a deleted comment loses its likes'
    );
    n++;
    const orphan = comments.getCommentRow(db, LEAD_A, ownerReply.id);
    assert.equal(orphan.parent_id, null, 'replies re-parent upward to top level');
    n++;
    const thread = comments.publicThread(db, LEAD_A, 'blog', postTarget);
    assert.ok(
      thread.comments.some((c) => c.id === ownerReply.id),
      'the orphaned reply still renders, now top-level'
    );
    n++;
    group('Part 2d likes', n);
  }

  // ---- 2e: public payloads, embed fallback, XSS carriage ----
  {
    let n = 0;
    const emb = sm.getEmbedRow(db, LEAD_A, 'comments');
    assert.ok(emb && emb.public_token, 'comments embed exists with a public token');
    n++;
    // Page mode: a published comment on the embed's page rides along.
    const pageComment = comments.createComment(db, LEAD_A, {
      target_type: 'page',
      target_id: 'about',
      author_name: 'Guest Bookie',
      author_email: 'guest@example.invalid',
      body: 'Lovely site!',
      visitor_token: TOK_A,
    });
    comments.setCommentStatus(db, LEAD_A, pageComment.comment.id, 'published');
    db.prepare('UPDATE site_module_embeds SET target_page_slug = ? WHERE id = ?').run('about', emb.id);
    const payload = sm.getPublicModuleByToken(db, emb.public_token);
    assert.equal(payload.module_type, 'comments');
    n++;
    assert.ok(payload.comments && payload.comments.thread, 'page mode carries the page thread');
    n++;
    assert.equal(payload.comments.thread.comments.length, 1, 'the guestbook comment is in the payload');
    n++;
    assert.equal(payload.comments.thread.target.target_id, 'about');
    n++;
    // A stored-XSS attempt is carried as inert raw text in the JSON —
    // rendering safety is the embed's textContent discipline (Part 1).
    const xss = comments.createComment(db, LEAD_A, {
      target_type: 'page',
      target_id: 'about',
      author_name: '<img src=x onerror=alert(1)>',
      author_email: 'xss@example.invalid',
      body: '<script>alert("pwned")</script>',
      visitor_token: TOK_B,
    });
    comments.setCommentStatus(db, LEAD_A, xss.comment.id, 'published');
    const payload2 = sm.getPublicModuleByToken(db, emb.public_token);
    const carried = payload2.comments.thread.comments.find((c) => c.id === xss.comment.id);
    assert.ok(carried, 'the XSS-attempt comment is in the thread');
    n++;
    assert.equal(carried.body, '<script>alert("pwned")</script>', 'the payload carries the body as raw plain text');
    n++;
    assert.equal(carried.author_name, '<img src=x onerror=alert(1)>', 'names ride as raw text too (escaped at render)');
    n++;
    // Item mode: the item payload carries the thread; an unknown key
    // falls back to the bare payload — NEVER an error (Batch 130).
    comments.updateCommentsConfig(db, LEAD_A, { target_mode: 'item', target_type: 'blog' });
    const itemView = sm.getPublicModuleItem(db, emb.public_token, postSlug);
    assert.ok(itemView.comments && itemView.comments.thread, 'item mode carries the thread with the item');
    n++;
    assert.ok(
      itemView.comments.thread.comments.some((c) => c.id === ownerReply.id),
      'the blog thread is the one the comments block shows'
    );
    n++;
    const dormant = sm.getPublicModuleItem(db, emb.public_token, 'definitely-not-a-post');
    assert.ok(!dormant.item, 'an unresolvable key returns the base payload without an item');
    n++;
    assert.ok(!(dormant.comments && dormant.comments.thread), 'and without a thread — dormant, not an error card');
    n++;
    comments.updateCommentsConfig(db, LEAD_A, { target_mode: 'page', target_type: 'blog' });
    group('Part 2e payloads + embed fallback + XSS carriage', n);
  }

  // ---- 2f: owner surfaces, MCP dispatch, purge ----
  {
    let n = 0;
    const listed = await portalModules.listModuleItems(WS_ID, LEAD_A, 'comments', 'a131@example.invalid');
    assert.ok(listed.comments && listed.comments.config, 'portal list carries the comments block');
    n++;
    assert.ok(listed.comments.counts.total >= 5, 'owner counts see every status');
    n++;
    assert.ok(listed.comments.counts.pending >= 2, 'the queue counts the held comments');
    n++;
    assert.ok(Array.isArray(listed.comments.comments), 'owner comment list rides along');
    n++;
    const targets = comments.listCommentTargets(db, LEAD_A);
    const blogTarget = targets.find((t) => t.target_type === 'blog');
    assert.ok(blogTarget && blogTarget.comments >= 3, 'targets roll up per-item counts');
    n++;
    assert.ok(blogTarget.likes >= 2, 'targets roll up the item like count');
    n++;
    // Config through the portal service.
    const saved = await portalModules.saveCommentsConfig(WS_ID, LEAD_A, { heading: 'Join in' }, 'a131@example.invalid');
    assert.equal(saved.config.heading, 'Join in', 'portal config save round-trips');
    n++;
    await portalModules.saveCommentsConfig(WS_ID, LEAD_A, { heading: 'Comments' }, 'a131@example.invalid');
    // MCP dispatch (the design agent's path).
    const mcp = require(path.join(root, 'server/mcp.js'));
    const cfgRes = await mcp.callTool(WS_ID, 'comments.getConfig', { leadId: LEAD_A }, {});
    assert.ok(cfgRes && !cfgRes.isError, 'MCP comments.getConfig answers');
    n++;
    const listRes = await mcp.callTool(WS_ID, 'comments.list', { leadId: LEAD_A, status: 'pending' }, {});
    assert.ok(listRes && !listRes.isError, 'MCP comments.list answers');
    n++;
    const pendingRow = db
      .prepare("SELECT id FROM module_comments WHERE lead_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
      .get(LEAD_A);
    const modRes = await mcp.callTool(
      WS_ID,
      'comments.moderate',
      { leadId: LEAD_A, id: pendingRow.id, action: 'approve' },
      {}
    );
    assert.ok(modRes && !modRes.isError, 'MCP comments.moderate answers');
    n++;
    assert.equal(comments.getCommentRow(db, LEAD_A, pendingRow.id).status, 'published', 'the MCP approval landed');
    n++;
    // Purge: deleting lead B's comments module sweeps its data and
    // deletes the LeadScout events that referenced its comments.
    db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
      LEAD_B,
      'Beta Site',
      'published',
      JSON.stringify([{ slug: 'about', title: 'About Beta' }]),
      '{}'
    );
    const bComment = comments.createComment(db, LEAD_B, {
      target_type: 'page',
      target_id: 'about',
      author_name: 'Bee',
      author_email: 'bee@example.invalid',
      body: 'Lead B was here.',
      visitor_token: TOK_A,
    });
    assert.ok(bComment.comment.id, 'lead B comment created');
    n++;
    comments.toggleLike(db, LEAD_B, { target_type: 'page', target_id: 'about', visitor_token: TOK_B });
    const bEvents = db
      .prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE lead_id = ? AND kind = 'comment'")
      .get(LEAD_B);
    assert.equal(bEvents.c, 1, 'lead B capture event exists before the purge');
    n++;
    sm.deleteModule(db, LEAD_B, 'comments');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM module_comments WHERE lead_id = ?').get(LEAD_B).c,
      0,
      'purge sweeps the comments'
    );
    n++;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM module_likes WHERE lead_id = ?').get(LEAD_B).c,
      0,
      'purge sweeps the likes'
    );
    n++;
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE lead_id = ? AND kind = 'comment'").get(LEAD_B).c,
      0,
      'purge removes the LeadScout events that referenced the comments'
    );
    n++;
    assert.ok(
      db.prepare('SELECT COUNT(*) AS c FROM module_comments WHERE lead_id = ?').get(LEAD_A).c >= 5,
      "lead A's comments are untouched by lead B's purge"
    );
    n++;
    group('Part 2f owner surfaces + MCP + purge', n);
  }

  // ---- 2g: finisher — Batch 133 detail wiring + lead cascades ----
  {
    let n = 0;
    const embedSrc = read('public/js/module-embed.js');
    assert.ok(embedSrc.includes('mountDetailComments'), 'the detail boot mounts the comments block');
    n++;
    assert.ok(embedSrc.includes('data-bp-detail-comments'), 'detail posts carry the detail marker');
    n++;
    const smSrcG = read('server/siteModules.js');
    assert.ok(smSrcG.includes('detail_comments'), 'item payloads carry detail_comments');
    n++;
    assert.equal(typeof comments.publicDetailContext, 'function', 'the detail context service exists');
    n++;
    // The detail context is keyed by the ITEM's own type — it resolves
    // the product even though the block binding is page/blog here.
    const dctx = comments.publicDetailContext(db, LEAD_A, 'ecommerce', String(product.id));
    assert.ok(dctx && dctx.thread, 'detail context resolves a product target');
    n++;
    assert.equal(dctx.target.target_type, 'ecommerce', 'detail target is the product');
    n++;
    assert.equal(
      comments.publicDetailContext(db, LEAD_A, 'blog', postDraft.slug || String(postDraft.id)),
      null,
      'a draft item gets no detail thread (dormant, not an error)'
    );
    n++;
    // The item payload (the detail page's resolution path) carries it.
    const shopEmb = sm.getEmbedRow(db, LEAD_A, 'ecommerce');
    const itemPayload = sm.getPublicModuleItem(db, shopEmb.public_token, product.slug || String(product.id));
    assert.ok(itemPayload.detail_comments, 'product item payload carries detail_comments');
    n++;
    assert.equal(
      itemPayload.detail_comments.thread.target.target_type,
      'ecommerce',
      'payload thread is the product thread'
    );
    n++;
    const cEmb = sm.getEmbedRow(db, LEAD_A, 'comments');
    assert.equal(itemPayload.detail_comments.token, cEmb.public_token, 'payload carries the comments embed token');
    n++;
    // A detail-surface post bypasses the block binding (page mode
    // here) and lands on the item's own target, held as usual.
    const dPost = comments.createPublicComment(
      db,
      cEmb.public_token,
      {
        target_type: 'ecommerce',
        target_id: String(product.id),
        name: 'Detail Visitor',
        email: 'detail131@example.invalid',
        body: 'Posted from the product detail page.',
        visitor_token: TOK_C,
        detail: 1,
      },
      {}
    );
    assert.equal(dPost.comment.target_type, 'ecommerce', 'detail post lands on the product');
    n++;
    assert.equal(dPost.status, 'pending', 'detail post is held for moderation like any other');
    n++;
    // Lead cascades (Batch 134 lesson): delete drops all three
    // tables; merge moves comments + likes and singletons the config.
    const leadEngine = require(path.join(root, 'src/leadEngine.js'));
    const LEAD_C = 13103;
    const LEAD_D = 13104;
    for (const [id, name, email] of [
      [LEAD_C, 'B131 Cascade Delete', 'c131@example.invalid'],
      [LEAD_D, 'B131 Cascade Merge', 'd131@example.invalid'],
    ]) {
      db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
        id,
        name,
        email,
        'customer'
      );
    }
    const cPost = sm.createBlogPost(db, LEAD_C, { title: 'Cascade Post', body_html: '<p>c</p>', status: 'published' });
    const cMade = comments.createComment(db, LEAD_C, {
      target_type: 'blog',
      target_id: String(cPost.id),
      author_name: 'Cascade Casey',
      author_email: 'casey131@example.invalid',
      body: 'Delete me with my lead.',
      visitor_token: TOK_A,
    });
    comments.getCommentsConfig(db, LEAD_C);
    comments.toggleLike(db, LEAD_C, {
      target_type: 'comment',
      target_id: String(cMade.comment.id),
      visitor_token: TOK_A,
    });
    leadEngine.deleteLead(db, LEAD_C);
    for (const t of ['module_comments', 'module_likes', 'comments_configs']) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE lead_id = ?`).get(LEAD_C).c,
        0,
        `deleteLead drops ${t}`
      );
      n++;
    }
    const dPost2 = sm.createBlogPost(db, LEAD_D, { title: 'Merge Post', body_html: '<p>m</p>', status: 'published' });
    const dMade = comments.createComment(db, LEAD_D, {
      target_type: 'blog',
      target_id: String(dPost2.id),
      author_name: 'Merge Molly',
      author_email: 'molly131@example.invalid',
      body: 'Merge me with my lead.',
      visitor_token: TOK_B,
    });
    comments.toggleLike(db, LEAD_D, { target_type: 'blog', target_id: String(dPost2.id), visitor_token: TOK_B });
    comments.getCommentsConfig(db, LEAD_D);
    leadEngine.mergeLeads(db, LEAD_A, [LEAD_D]);
    const moved = db.prepare('SELECT lead_id FROM module_comments WHERE id = ?').get(dMade.comment.id);
    assert.equal(moved.lead_id, LEAD_A, 'merge moves comments to the keeper');
    n++;
    const movedLike = db.prepare('SELECT COUNT(*) AS c FROM module_likes WHERE lead_id = ?').get(LEAD_A).c;
    assert.ok(movedLike >= 1, 'merge moves likes to the keeper');
    n++;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM comments_configs WHERE lead_id = ?').get(LEAD_D).c,
      0,
      'merge singletons the comments config (keeper wins)'
    );
    n++;
    group('Part 2g detail wiring + lead cascades', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner131@example.invalid',
      h: bcrypt.hashSync('UnusedPass131!', 12),
      n: 'B131 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner131@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B131 Alpha Blooms' }
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

      const emb = sm.getEmbedRow(db, LEAD_A, 'comments');
      const pub = `${BASE}/api/v1/modules/public/${emb.public_token}`;
      // The public payload serves the page thread built in Part 2.
      {
        const res = await fetch(pub);
        assert.equal(res.status, 200, 'public payload serves');
        const data = await json(res);
        const payload = data.data || data;
        assert.equal(payload.module_type, 'comments');
        assert.ok(payload.comments && payload.comments.thread, 'page thread rides the payload');
        assert.ok(
          payload.comments.thread.comments.some((c) => c.body === 'Lovely site!'),
          'the approved guestbook comment is public'
        );
        assert.ok(!JSON.stringify(payload).includes('guest@example.invalid'), 'commenter emails never ship publicly');
        n += 4;
      }
      // A visitor posts: held by default, state-blind response.
      let httpCommentId = null;
      {
        const res = await fetch(`${pub}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Http Hanna',
            email: 'hanna@example.invalid',
            body: 'Posted over HTTP.',
            visitor_token: TOK_C,
          }),
        });
        assert.equal(res.status, 200, 'public comment post answers');
        const data = await json(res);
        const d = data.data || data;
        assert.equal(d.status, 'pending', 'the HTTP comment is held by default');
        assert.match(d.message || '', /awaiting approval/, 'the held message is the state-blind one');
        httpCommentId = d.comment && d.comment.id;
        assert.ok(httpCommentId, 'the response carries the new comment');
        n += 4;
        const after = await json(await fetch(pub));
        const p2 = after.data || after;
        assert.ok(
          !p2.comments.thread.comments.some((c) => c.id === httpCommentId),
          'the held HTTP comment is NOT in the public thread'
        );
        n++;
      }
      // Likes over HTTP: toggle + the caller's state read.
      {
        const likeRes = await fetch(`${pub}/comments/like`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_type: 'page', target_id: 'about', visitor_token: TOK_C }),
        });
        assert.equal(likeRes.status, 200, 'public like answers');
        const ld = await json(likeRes);
        const like = ld.data || ld;
        assert.deepEqual([like.liked, like.count], [true, 1], 'the like lands with the server count');
        n += 2;
        const st = await json(
          await fetch(`${pub}/comments/state?target_type=page&target_id=about&v=${encodeURIComponent(TOK_C)}`)
        );
        const sd = st.data || st;
        assert.equal(sd.item_liked, true, 'the state read shows the pressed button');
        n++;
        const un = await json(
          await fetch(`${pub}/comments/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_type: 'page', target_id: 'about', visitor_token: TOK_C }),
          })
        );
        const ud = un.data || un;
        assert.deepEqual([ud.liked, ud.count], [false, 0], 'a second toggle removes it');
        n++;
      }
      // Portal owner session: approve the held comment, reply, and
      // flip moderation — all through the real routes.
      {
        const owner = makeJar();
        const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
        const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
        const login = await post(owner, '/api/v1/portal/login', { email: 'owner131@example.invalid', password: PW });
        assert.equal(login.status, 200, 'portal owner login');
        n++;
        const mod = await put(owner, `/api/v1/portal/modules/comments/${httpCommentId}`, { status: 'published' });
        assert.equal(mod.status, 200, 'portal moderation route answers');
        n++;
        const after = await json(await fetch(pub));
        const p3 = after.data || after;
        assert.ok(
          p3.comments.thread.comments.some((c) => c.id === httpCommentId),
          'the approved HTTP comment is now public'
        );
        n++;
        const reply = await post(owner, `/api/v1/portal/modules/comments/${httpCommentId}/reply`, {
          body: 'Owner over HTTP — welcome!',
        });
        assert.equal(reply.status, 200, 'portal reply route answers');
        n++;
        const after2 = await json(await fetch(pub));
        const p4 = after2.data || after2;
        const parent = p4.comments.thread.comments.find((c) => c.id === httpCommentId);
        assert.ok(
          parent && parent.replies.some((r) => r.is_owner && r.body === 'Owner over HTTP — welcome!'),
          'the owner reply renders badged under the comment'
        );
        n++;
        const cfgPut = await put(owner, '/api/v1/portal/modules/comments/config', { moderation: 'auto' });
        assert.equal(cfgPut.status, 200, 'portal config route answers');
        n++;
        const auto = await fetch(`${pub}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Auto Amy',
            email: 'amy@example.invalid',
            body: 'Live immediately now.',
            visitor_token: TOK_B,
          }),
        });
        const ad = await json(auto);
        assert.equal((ad.data || ad).status, 'published', 'auto mode publishes over HTTP too');
        n++;
        await put(owner, '/api/v1/portal/modules/comments/config', { moderation: 'held' });
      }
      group('Part 3 HTTP portal + public flow', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH131 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH131 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
