'use strict';
/**
 * Batch 143 — FULL CODEBASE REVIEW fix batch (Ely's 2026-11-04 order).
 *
 * Every fix in this batch came from a reproduced finding in the
 * step-by-step review of Batches 122–142 era code. This suite pins
 * the FIXED behavior so none of the defects can recur silently:
 *
 *   Part 1 — source pins (front-end + renderer + MCP text):
 *     esc() single-quote parity in the four embed/portal files;
 *     portal pagerLoad + loadModuleItems error surface; staff
 *     mountPreview destroy wiring; Domains cfLoadFailed split;
 *     renderSite freeform spacing-guard injection; detail-main
 *     22px floor; clientMcp fonts.list branch above the leadId
 *     gates; exporter stale-cleanup + unsafe-segment guard.
 *   Part 2 — aiRouting.classifyError: coded local refusals (SSRF
 *     guard) never fail over; transport network wrappers do;
 *     402/408 are provider-side.
 *   Part 3 — validateLeadInput rejects object/array string fields
 *     (the '[object Object]' lead).
 *   Part 4 — deleteLead / mergeLeads cascades cover EVERY lead_id
 *     table the fixture schema creates (inventory derived from the
 *     schema, keep-list = design_jobs only); the duplicate-email
 *     newsletter merge no longer crashes; child rows
 *     (course_lessons / gallery_images) follow their parents.
 *   Part 5 — comments: like toggle refuses unusable visitor
 *     tokens; owner reply to a REJECTED comment is refused.
 *   Part 6 — payments: membership checkout with
 *     payment_status 'unpaid' grants NO access; a canceled member
 *     subscription cannot be resurrected by a stale event; shop
 *     webhook verifies amount+currency against the order; a full
 *     charge.refunded marks the order refunded.
 *   Part 7 — designJobs claim is atomic: a second claimer gets
 *     nothing while the first job is in progress.
 *   Part 8 — MCP parity: tool defs are unique; photocapture
 *     .addToGallery and checkout.getConfig are SEPARATE defs;
 *     fonts.list is dispatchable lead-free.
 *   Part 9 — exporter: stale pages/detail shells are removed on
 *     re-export, images/ is never touched, hostile detail keys
 *     are skipped.
 *   Part 10 — platform billing syncSubscription terminal guard:
 *     a stale 'active' event cannot resurrect a canceled
 *     subscription for the same Stripe sub id.
 *   Part 11 — sqlite jobExecutionLock: a >24h foreign-host lock
 *     is reclaimable; a fresh foreign-host lock still fails
 *     closed with JOB_RUNNING.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.REGRESSION_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch143-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = path.join(process.env.REGRESSION_TMPDIR, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 43).toString('base64');
process.env.PLATFORM_DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'platform.db');
process.env.WORKSPACE_DATA_DIR = path.join(process.env.REGRESSION_TMPDIR, 'workspaces');
process.env.DB_PATH = path.join(process.env.REGRESSION_TMPDIR, 'app.db');
process.env.SQLITE_PATH = process.env.DB_PATH;
process.env.COOKIE_SECURE = 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || 'true';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'dry';
process.env.STRIPE_TEST_MODE = process.env.STRIPE_TEST_MODE || 'true';
process.env.CAPTCHA_OPTIONAL = '1';
// Fixture secrets are fragment-assembled, never single literals.
process.env.SESSION_SECRET = ['batch143', 'session', 'secret', '0123456789abcdef'].join('-');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected a throw with code ${code}`);
}

/* ================= Part 1 — source pins ================= */
{
  let n = 0;
  const portal = read('public/js/portal.js');
  const app = read('public/js/app.js');
  const modEmbed = read('public/js/module-embed.js');
  const chatEmbed = read('public/js/chat-embed.js');
  const formEmbed = read('public/js/form-embed.js');
  for (const [label, src] of [
    ['portal', portal],
    ['module-embed', modEmbed],
    ['chat-embed', chatEmbed],
    ['form-embed', formEmbed],
  ]) {
    assert.ok(src.includes(".replace(/'/g, '&#39;')"), `${label} esc() escapes single quotes (app.js parity)`);
    n++;
  }
  assert.ok(portal.includes('function pagerLoad('), 'portal pagers advance via pagerLoad');
  n++;
  assert.ok(portal.includes("moduleMsg('Could not load this list"), 'loadModuleItems surfaces load failures');
  n++;
  assert.ok(portal.includes("if (!Number.isFinite(v)) return '—';"), 'portal money() shows a dash for non-finite amounts');
  n++;
  assert.ok(app.includes('let activePreviewHandle = null;'), 'app tracks the active preview handle');
  n++;
  assert.ok(app.includes('destroyActivePreview();\n  closeNav();'), 'navigate() destroys the active preview');
  n++;
  assert.ok(app.includes('const cfLoadFailed = !cfRes;'), 'Domains page distinguishes CF fetch failure');
  n++;
  assert.ok(!app.includes('function dataOf('), 'app.js dataOf orphan removed');
  n++;
  assert.ok(!portal.includes('function rewriteHexInPreviewDoc('), 'portal rewriteHexInPreviewDoc orphan removed');
  n++;
  assert.ok(!portal.includes('function ensureFrameFonts('), 'portal ensureFrameFonts orphan removed');
  n++;
  assert.ok(!portal.includes('async function startPortalCheckout('), 'portal startPortalCheckout alias removed');
  n++;

  const engine = read('src/websiteEngine.js');
  assert.ok(
    engine.includes('return injectSpacingGuardScript(upsertFontLinks(appendHtmlTail(doc, scripts), t));'),
    'renderSite single-freeform path injects the spacing-guard script'
  );
  n++;
  assert.ok(engine.includes('clamp(22px,3.5vw,2rem)'), 'detail main horizontal padding floor is 22px');
  n++;
  assert.ok(engine.includes('stale export cleanup'), 'writeStaticPages carries the stale-export cleanup');
  n++;
  assert.ok(engine.includes('unsafe type/key segment'), 'writeStaticPages validates detail path segments');
  n++;
  assert.ok(!engine.includes('freeformPreviewInner'), 'freeformPreviewInner orphan removed');
  n++;
  const previewChrome = read('src/previewChrome.js');
  assert.ok(previewChrome.includes('withFileTypes: true'), 'previewChrome lists export HTML recursively');
  n++;

  const clientMcp = read('server/clientMcp.js');
  assert.ok(clientMcp.includes("name !== 'fonts.list'"), 'clientMcp entry gate exempts fonts.list');
  n++;
  const fontsIdx = clientMcp.indexOf("if (name === 'fonts.list')");
  const gateIdx = clientMcp.indexOf("if (!leadId) throw new Error('leadId is required');\n\n  if (name === 'site.get')");
  assert.ok(fontsIdx > 0 && gateIdx > 0 && fontsIdx < gateIdx, 'fonts.list branch sits above the leadId gate');
  n++;
  assert.equal(clientMcp.split("if (name === 'fonts.list')").length - 1, 1, 'exactly one fonts.list branch (no dead duplicate)');
  n++;

  const siteModules = read('server/siteModules.js');
  for (const orphan of ['injectContentSectionIntoHtml', 'updateLesson', 'setMembershipTierActive', 'createAppointment']) {
    assert.ok(!siteModules.includes(orphan), `siteModules orphan ${orphan} removed`);
    n++;
  }
  const mcp = read('server/mcp.js');
  assert.ok(mcp.includes("name: 'photocapture.addToGallery'") && mcp.includes("name: 'checkout.getConfig'"), 'addToGallery + checkout.getConfig defs both present');
  n++;
  group('Part 1 source pins', n);
}

/* ================= Part 2 — classifyError ================= */
{
  let n = 0;
  const aiRouting = require(path.join(root, 'server/aiRouting.js'));
  const coded = (code) => Object.assign(new Error('x'), { code });
  const statused = (status) => Object.assign(new Error('x'), { status });
  assert.equal(aiRouting.classifyError(coded('UNSAFE_BASE_URL')).failover, false, 'SSRF guard refusal does not fail over');
  n++;
  assert.equal(aiRouting.classifyError(coded('INVALID_BASE_URL')).failover, false, 'invalid base URL does not fail over');
  n++;
  assert.equal(aiRouting.classifyError(coded('UNSAFE_BASE_URL')).reason, 'UNSAFE_BASE_URL', 'refusal reason is the code, not network/timeout');
  n++;
  assert.equal(aiRouting.classifyError(coded('AI_NETWORK_ERROR')).failover, true, 'task-stack network wrapper fails over');
  n++;
  assert.equal(aiRouting.classifyError(coded('MUSE_NETWORK')).failover, true, 'agent-stack network wrapper fails over');
  n++;
  assert.equal(aiRouting.classifyError(coded('ECONNRESET')).failover, true, 'raw network errno fails over');
  n++;
  assert.equal(aiRouting.classifyError(new Error('plain')).failover, true, 'uncoded status-less error fails over (non-JSON body case)');
  n++;
  const c402 = aiRouting.classifyError(statused(402));
  assert.ok(c402.failover && c402.cooldownMs === 10 * 60 * 1000, '402 fails over with the auth-class cooldown');
  n++;
  assert.equal(aiRouting.classifyError(statused(408)).failover, true, '408 fails over');
  n++;
  assert.equal(aiRouting.classifyError(statused(400)).failover, false, '400 stays a local request bug');
  n++;
  assert.equal(aiRouting.classifyError(statused(401)).failover, true, '401 fails over');
  n++;
  group('Part 2 classifyError', n);
}

/* ---- shared tenant fixture (Parts 3–6) ---- */
const Database = require('better-sqlite3');
function makeTenantDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY, business_name TEXT DEFAULT '', email TEXT DEFAULT '',
      email_norm TEXT DEFAULT '', phone TEXT DEFAULT '', website TEXT DEFAULT '',
      website_kind TEXT DEFAULT 'bitpype', website_platform TEXT,
      status TEXT DEFAULT 'lead',
      notes TEXT DEFAULT '', tags TEXT DEFAULT '', category TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', postal_code TEXT DEFAULT '', country TEXT DEFAULT '', latitude REAL, longitude REAL, rating REAL, review_count INTEGER, description TEXT DEFAULT '',
      hours TEXT DEFAULT '', services TEXT DEFAULT '', social_links TEXT DEFAULT '',
      source TEXT DEFAULT '', source_ref TEXT DEFAULT '', lead_group TEXT,
      address TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, name TEXT NOT NULL DEFAULT '',
      preview_path TEXT NOT NULL DEFAULT '', archived_at TEXT,
      pages TEXT NOT NULL DEFAULT '[]', theme TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE site_domains (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, website_id INTEGER, domain TEXT);
  `);
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));
  try {
    leadEngine.ensureLeadColumns(db);
  } catch {
    /* scaffold already carries the columns */
  }
  require(path.join(root, 'server/siteModules.js')).ensureTables(db);
  require(path.join(root, 'server/categories.js')).ensureTables(db);
  require(path.join(root, 'server/moduleShare.js')).ensureTables(db);
  require(path.join(root, 'server/comments.js')).ensureTables(db);
  try {
    require(path.join(root, 'server/newsletter.js')).ensureTables(db);
  } catch {
    /* optional in fixture */
  }
  try {
    require(path.join(root, 'server/chatbot.js')).ensureTables(db);
  } catch {
    /* optional in fixture */
  }
  try {
    require(path.join(root, 'server/portalContacts.js')).ensureTables(db);
  } catch {
    /* optional in fixture */
  }
  return db;
}
function addLeadRow(db, id, name, email) {
  db.prepare('INSERT INTO leads (id, business_name, email) VALUES (?, ?, ?)').run(id, name, email);
}
function leadIdTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
    .filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'lead_id'));
}
function rowsForLead(db, leadId) {
  const out = {};
  for (const t of leadIdTables(db)) {
    const c = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE lead_id = ?`).get(leadId).c;
    if (c > 0) out[t] = c;
  }
  return out;
}

/* ================= Part 3 — lead input validation ================= */
{
  let n = 0;
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));
  const db = makeTenantDb();
  throwsCode(() => leadEngine.createLead(db, { business_name: { x: 1 } }), 'VALIDATION_ERROR');
  n++;
  throwsCode(() => leadEngine.createLead(db, { business_name: 'Ok', email: ['a@b.c'] }), 'VALIDATION_ERROR');
  n++;
  throwsCode(() => leadEngine.createLead(db, { business_name: 'Ok', city: { name: 'X' } }), 'VALIDATION_ERROR');
  n++;
  const ok = leadEngine.createLead(db, { business_name: 'Ok Biz', email: 'ok@example.invalid', tags: ['a'] });
  assert.ok(ok && ok.id, 'legit input (incl. array tags) still creates');
  n++;
  const stored = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(ok.id);
  assert.equal(stored.business_name, 'Ok Biz', 'stored name is the real string, never [object Object]');
  n++;
  group('Part 3 lead input validation', n);
}

/* ================= Part 4 — cascades ================= */
function seedLeadEverywhere(db, id, tag) {
  const sm = require(path.join(root, 'server/siteModules.js'));
  const cats = require(path.join(root, 'server/categories.js'));
  const comments = require(path.join(root, 'server/comments.js'));
  addLeadRow(db, id, 'Biz ' + tag, `${tag}@example.invalid`);
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  sm.createBlogPost(db, id, { title: tag + ' Post', status: 'published', body_html: '<p>x</p>' });
  const course = sm.createCourse(db, id, { title: tag + ' Course', slug: tag + '-course', status: 'published' });
  sm.addLesson(db, id, course.id, { title: tag + ' Lesson' });
  const album = sm.createAlbum(db, id, { title: tag + ' Album', status: 'published' });
  sm.addGalleryImage(db, id, album.id, { image_url: 'images/x.jpg', caption: 'c' });
  sm.createListing(db, id, { name: tag + ' Listing', status: 'published' });
  sm.createFaqItem(db, id, { question: 'Q?', answer_html: 'A', status: 'published' });
  sm.createTestimonial(db, id, { quote: 'Great', author_name: 'Jo', status: 'published' });
  sm.createTeamMember(db, id, { name: tag + ' Person', status: 'published' });
  sm.createEvent(db, id, { title: tag + ' Event', status: 'published' });
  sm.createOffer(db, id, { title: tag + ' Offer', status: 'published' });
  const mc = sm.createMenuCategory(db, id, { name: tag + ' Mains' });
  sm.createMenuItem(db, id, { name: tag + ' Dish', category_id: mc.id, status: 'published' });
  sm.createCareersPosting(db, id, { title: tag + ' Job', active: 1 });
  sm.createVideoItem(db, id, { title: tag + ' Vid', url: 'https://youtube.com/watch?v=abc12345678', status: 'published' });
  sm.createProduct(db, id, { name: tag + ' Fern', slug: tag + '-fern', price_cents: 100, status: 'published' });
  sm.createBookingService(db, id, { name: tag + ' Cut', status: 'published' });
  sm.createChart(db, id, { title: tag + ' Chart', source: 'manual', data: { labels: ['a'], series: [{ name: 's', values: [1] }] } });
  sm.updateDataTableConfig(db, id, { title: tag + ' Table', columns: [{ key: 'name', label: 'Name', type: 'text' }] });
  sm.createDataTableRow(db, id, { values: { name: tag } });
  sm.updateCallTrackingConfig(db, id, { display_number: '+15551110000' });
  ins('INSERT INTO calltracking_rotation_numbers (lead_id, phone_number) VALUES (?, ?)', id, '+15551110001');
  ins("INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status) VALUES (?, ?, '+1', '+2', 'completed')", id, 'CA' + tag + id);
  ins("INSERT INTO calls_billing (lead_id, month, last_billed_threshold, overage_due_credits) VALUES (?, '2026-11', 0, 0)", id);
  ins('INSERT INTO lead_payment_configs (lead_id, publishable_key) VALUES (?, ?)', id, 'pk_test_' + tag);
  sm.getMembersConfig(db, id);
  ins('INSERT INTO membership_tiers (lead_id, name, price_cents) VALUES (?, ?, 0)', id, tag + ' Tier');
  ins("INSERT INTO site_member_reset_tokens (lead_id, member_id, token_hash, expires_at) VALUES (?, 1, ?, datetime('now','+1 day'))", id, 'hash' + tag + id);
  sm.createEstimateOption(db, id, { label: tag + ' Opt' });
  sm.getEstimateConfig(db, id);
  sm.updatePhotoCaptureConfig(db, id, { heading: tag + ' photos' });
  sm.updateCheckoutConfig(db, id, { success_message: tag + ' thanks' });
  sm.createQrCode(db, id, { name: tag + ' QR', target_kind: 'url', target_ref: 'https://example.invalid/', status: 'published' });
  cats.createCategory(db, id, { scope: 'blog', name: tag + ' Cat', status: 'published' });
  try {
    const nl = require(path.join(root, 'server/newsletter.js'));
    nl.getConfig(db, id);
  } catch {
    /* newsletter tables optional in fixture */
  }
  ins('INSERT INTO newsletter_subscribers (lead_id, email, name, status) VALUES (?, ?, ?, ?)', id, `sub-${tag}@example.invalid`, 'Sub', 'active');
  comments.getCommentsConfig(db, id);
  ins(
    'INSERT INTO module_comments (lead_id, target_type, target_id, author_name, author_email, body, status) VALUES (?,?,?,?,?,?,?)',
    id,
    'page',
    'index',
    'Ann',
    `ann-${tag}@example.invalid`,
    'hi',
    'published'
  );
  return { course, album };
}
{
  let n = 0;
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));
  // DELETE: every lead_id table empties (keep-list: design_jobs only).
  {
    const db = makeTenantDb();
    seedLeadEverywhere(db, 9101, 'del');
    const before = rowsForLead(db, 9101);
    assert.ok(Object.keys(before).length >= 25, `fixture seeds a broad module surface (got ${Object.keys(before).length} tables)`);
    n++;
    leadEngine.deleteLead(db, 9101);
    const after = rowsForLead(db, 9101);
    assert.deepEqual(after, {}, `deleteLead leaves no lead_id rows behind (left: ${JSON.stringify(after)})`);
    n++;
    const lessons = db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c;
    const images = db.prepare('SELECT COUNT(*) c FROM gallery_images').get().c;
    assert.equal(lessons, 0, 'course_lessons swept with their courses');
    n++;
    assert.equal(images, 0, 'gallery_images swept with their albums');
    n++;
  }
  // MERGE: duplicate newsletter email must not crash; nothing strands.
  {
    const db = makeTenantDb();
    seedLeadEverywhere(db, 9102, 'keep');
    seedLeadEverywhere(db, 9103, 'drop');
    // The exact BUG-3 shape: BOTH leads subscribe the same email.
    db.prepare('INSERT INTO newsletter_subscribers (lead_id, email, name, status) VALUES (?, ?, ?, ?)').run(9102, 'shared@example.invalid', 'A', 'active');
    db.prepare('INSERT INTO newsletter_subscribers (lead_id, email, name, status) VALUES (?, ?, ?, ?)').run(9103, 'shared@example.invalid', 'B', 'active');
    const lessonsBefore = db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c;
    leadEngine.mergeLeads(db, 9102, [9103]);
    const stranded = rowsForLead(db, 9103);
    assert.deepEqual(stranded, {}, `merge strands nothing on the dropped lead (left: ${JSON.stringify(stranded)})`);
    n++;
    const shared = db.prepare("SELECT COUNT(*) c FROM newsletter_subscribers WHERE lead_id = 9102 AND email = 'shared@example.invalid'").get().c;
    assert.equal(shared, 1, 'shared subscriber deduped to one row on the surviving lead');
    n++;
    const lessonsAfter = db.prepare('SELECT COUNT(*) c FROM course_lessons').get().c;
    assert.equal(lessonsAfter, lessonsBefore, 'lessons survive the merge (re-parented, not orphaned)');
    n++;
    const orphanLessons = db
      .prepare('SELECT COUNT(*) c FROM course_lessons cl LEFT JOIN courses c ON c.id = cl.course_id WHERE c.id IS NULL')
      .get().c;
    assert.equal(orphanLessons, 0, 'no lesson points at a deleted course');
    n++;
    const orphanImages = db
      .prepare('SELECT COUNT(*) c FROM gallery_images gi LEFT JOIN gallery_albums ga ON ga.id = gi.album_id WHERE ga.id IS NULL')
      .get().c;
    assert.equal(orphanImages, 0, 'no gallery image points at a deleted album');
    n++;
  }
  group('Part 4 cascades', n);
}

/* ================= Part 5 — comments guards ================= */
{
  let n = 0;
  const sm = require(path.join(root, 'server/siteModules.js'));
  const comments = require(path.join(root, 'server/comments.js'));
  const db = makeTenantDb();
  const LEAD = 9201;
  addLeadRow(db, LEAD, 'Comments Biz', 'cb@example.invalid');
  const post = sm.createBlogPost(db, LEAD, { title: 'Live Post', status: 'published', body_html: '<p>x</p>' });
  const posted = comments.createComment(db, LEAD, {
    target_type: 'blog',
    target_id: post.id,
    author_name: 'Ann',
    author_email: 'ann@example.invalid',
    body: 'Hello there',
    visitor_token: 'aaaaaaaaaaaaaaaa',
  });
  assert.ok(posted && posted.comment && posted.comment.id, 'fixture comment posts (held by default)');
  n++;
  throwsCode(
    () => comments.toggleLike(db, LEAD, { target_type: 'blog', target_id: post.id, visitor_token: 'junk' }),
    'VALIDATION'
  );
  n++;
  throwsCode(() => comments.toggleLike(db, LEAD, { target_type: 'blog', target_id: post.id, visitor_token: '' }), 'VALIDATION');
  n++;
  const liked = comments.toggleLike(db, LEAD, { target_type: 'blog', target_id: post.id, visitor_token: 'bbbbbbbbbbbbbbbb' });
  assert.equal(liked.liked, true, 'a well-formed token can like');
  n++;
  const state = comments.likeState(db, LEAD, { visitor_token: 'junk' });
  assert.equal(state.item_liked, false, 'likeState for a junk token reports no likes');
  n++;
  assert.deepEqual(state.liked_comment_ids, [], 'likeState for a junk token has no liked comments (no shared bucket)');
  n++;
  // Owner reply to a REJECTED comment is refused.
  comments.setCommentStatus(db, LEAD, posted.comment.id, 'rejected');
  throwsCode(() => comments.replyAsOwner(db, LEAD, posted.comment.id, { body: 'Owner reply' }), 'VALIDATION');
  n++;
  group('Part 5 comments guards', n);
}

/* ================= Part 6 — payments ================= */
{
  let n = 0;
  const sm = require(path.join(root, 'server/siteModules.js'));
  const db = makeTenantDb();
  const LEAD = 9301;
  addLeadRow(db, LEAD, 'Pay Biz', 'pay@example.invalid');
  // (a) membership checkout completed UNPAID grants nothing.
  const tier = sm.insertMembershipTier(
    db,
    LEAD,
    { name: 'Gold', description: '', price_cents: 2500, interval: 'month', sort_order: 0 },
    { active: true, stripe_product_id: 'prod_fix', stripe_price_id: 'price_fix' }
  );
  sm.applyMembershipStripeEvent(db, {
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { bitpype_lead_id: String(LEAD), bitpype_member_id: '777', bitpype_tier_id: String(tier.id), bitpype_key_source: 'unified' },
        customer: 'cus_fix',
        subscription: 'sub_unpaid',
        payment_status: 'unpaid',
      },
    },
  });
  const subUnpaid = sm.getMemberSubscriptionByStripeId(db, 'sub_unpaid');
  assert.notEqual(subUnpaid.status, 'trialing', "unpaid checkout does not store 'trialing'");
  n++;
  const info = sm.memberAccessInfo(db, LEAD, { id: 777, comp_tier_id: null, comp_until: null });
  assert.equal(info.has_paid, false, 'unpaid checkout grants no paid access');
  n++;
  // (b) canceled member subscription is terminal for its Stripe id.
  sm.upsertMemberSubscription(db, {
    lead_id: LEAD,
    member_id: 778,
    tier_id: tier.id,
    stripe_customer_id: 'cus_fix2',
    stripe_subscription_id: 'sub_dead',
    status: 'canceled',
    price_cents: 2500,
  });
  sm.upsertMemberSubscription(db, {
    lead_id: LEAD,
    member_id: 778,
    tier_id: tier.id,
    stripe_customer_id: 'cus_fix2',
    stripe_subscription_id: 'sub_dead',
    status: 'active',
    price_cents: 2500,
  });
  assert.equal(sm.getMemberSubscriptionByStripeId(db, 'sub_dead').status, 'canceled', 'stale active event cannot resurrect a canceled subscription');
  n++;
  // (c)+(d) shop webhook amount verification + full refund. The
  // order row shape mirrors the reviewers' repro (single-item
  // legacy columns on ecommerce_orders).
  db.prepare(
    `INSERT INTO ecommerce_orders (lead_id, product_id, product_name, amount_cents, currency, status, stripe_session_id, stripe_payment_intent, stripe_key_source)
     VALUES (?, 1, 'Monstera', 5800, 'USD', 'pending', 'cs_fix', 'pi_fix', 'unified')`
  ).run(LEAD);
  sm.applyShopStripeEvent(db, {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_fix', payment_intent: 'pi_fix', payment_status: 'paid', amount_total: 100, currency: 'jpy', customer_details: { email: 'b@x.invalid' } } },
  });
  assert.notEqual(sm.getShopOrderBySession(db, 'cs_fix').status, 'paid', 'amount/currency mismatch does not fulfill the order');
  n++;
  sm.applyShopStripeEvent(db, {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_fix', payment_intent: 'pi_fix', payment_status: 'paid', amount_total: 5800, currency: 'usd', customer_details: { email: 'b@x.invalid' } } },
  });
  assert.equal(sm.getShopOrderBySession(db, 'cs_fix').status, 'paid', 'matching amount + currency fulfills the order');
  n++;
  sm.applyShopStripeEvent(db, {
    type: 'charge.refunded',
    data: { object: { id: 'ch_fix', payment_intent: 'pi_fix', amount: 5800, amount_refunded: 5800, currency: 'usd' } },
  });
  assert.equal(sm.getShopOrderBySession(db, 'cs_fix').status, 'refunded', 'full charge.refunded marks the order refunded');
  n++;
  group('Part 6 payments', n);
}

/* ================= Part 7 — design job claim ================= */
{
  let n = 0;
  const designJobs = require(path.join(root, 'src/designJobs.js'));
  const db = new Database(':memory:');
  const job = designJobs.createJob(db, { type: 'other', title: 'Claim Me', instructions: 'Do the thing.' });
  assert.ok(job && job.id, 'fixture job created');
  n++;
  const claimed = designJobs.claimNextAgentJob(db);
  assert.ok(claimed && Number(claimed.id) === Number(job.id), 'first claimer receives the job');
  n++;
  assert.equal(claimed.status, 'in_progress', 'claimed job is in_progress');
  n++;
  const second = designJobs.claimNextAgentJob(db);
  assert.equal(second, null, 'second claimer receives nothing while the job is in progress');
  n++;
  group('Part 7 design job claim', n);
}

/* ================= Part 8 — MCP parity ================= */
{
  let n = 0;
  const mcp = require(path.join(root, 'server/mcp.js'));
  const defs = mcp.toolDefs();
  const names = defs.map((d) => d.name);
  assert.equal(new Set(names).size, names.length, 'tool defs have no duplicate names');
  n++;
  const addToGallery = defs.find((d) => d.name === 'photocapture.addToGallery');
  assert.ok(addToGallery, 'photocapture.addToGallery is back in tools/list');
  n++;
  assert.ok(
    addToGallery.inputSchema && addToGallery.inputSchema.properties && 'album_id' in addToGallery.inputSchema.properties,
    'addToGallery carries its own schema (album_id)'
  );
  n++;
  const getConfig = defs.find((d) => d.name === 'checkout.getConfig');
  assert.ok(getConfig && getConfig !== addToGallery, 'checkout.getConfig is a separate def');
  n++;
  assert.ok(!('album_id' in (getConfig.inputSchema.properties || {})), 'checkout.getConfig no longer carries the addToGallery schema');
  n++;
  const clientNames = mcp.clientToolDefs().map((d) => d.name);
  assert.ok(clientNames.includes('photocapture.addToGallery'), 'client-scoped tokens regain addToGallery');
  n++;
  assert.ok(clientNames.includes('fonts.list'), 'fonts.list is a client tool def');
  n++;
  group('Part 8 MCP parity', n);
}

/* ================= Part 9 — exporter cleanup ================= */
{
  let n = 0;
  const engine = require(path.join(root, 'src/websiteEngine.js'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch143-export-'));
  // Pre-seed a previous export's leftovers.
  fs.mkdirSync(path.join(outDir, 'detail', 'ecommerce'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'detail', 'ecommerce', 'gone-item.html'), 'stale shell');
  fs.writeFileSync(path.join(outDir, 'old-page.html'), 'stale page');
  fs.writeFileSync(path.join(outDir, 'images', 'keep.png'), 'owner upload');
  const pages = [
    { slug: '/', title: 'Home', sections: [{ type: 'heading', content: { title: 'B143 Plants' } }] },
    { slug: 'shop', title: 'Shop', sections: [{ type: 'heading', content: { title: 'Shop' } }] },
  ];
  engine.writeStaticPages(pages, {}, outDir, {
    seo: {
      baseUrl: 'https://plants143.example',
      business: null,
      moduleFaqItems: [],
      gscToken: '',
      blog: null,
      detail: { types: { ecommerce: { token: 'tok', page: 'shop', items: ['good-key', 'bad/key', '..'] } } },
    },
    siteUpdatedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.ok(fs.existsSync(path.join(outDir, 'detail', 'ecommerce', 'good-key.html')), 'shell written for the valid key');
  n++;
  assert.ok(!fs.existsSync(path.join(outDir, 'detail', 'ecommerce', 'gone-item.html')), 'stale detail shell removed on re-export');
  n++;
  assert.ok(!fs.existsSync(path.join(outDir, 'old-page.html')), 'stale top-level page removed on re-export');
  n++;
  assert.ok(fs.existsSync(path.join(outDir, 'images', 'keep.png')), 'images/ is never touched by cleanup');
  n++;
  assert.ok(!fs.existsSync(path.join(outDir, 'detail', 'bad')), 'hostile detail key wrote nothing outside its segment');
  n++;
  group('Part 9 exporter cleanup', n);
}

/* ================= Parts 10–11 — platform DB (async) ================= */
(async () => {
  const { migrate, query } = require(path.join(root, 'server/db.js'));
  await migrate();
  {
    let n = 0;
    const billing = require(path.join(root, 'server/billing.js'));
    await query(
      "INSERT INTO users (email, name, password_hash, status) VALUES ('b143@example.invalid', 'B143', '!', 'active')"
    );
    const rows = await query("SELECT id FROM users WHERE email = 'b143@example.invalid'");
    const uid = rows[0].id;
    const sub = (status, id = 'sub_143') => ({
      id,
      metadata: { user_id: String(uid), plan: 'standard' },
      customer: 'cus_143',
      status,
      items: { data: [] },
      current_period_end: 1893456000,
      cancel_at_period_end: false,
    });
    await billing.syncSubscription(sub('active'));
    let u = (await query('SELECT subscription_status, billing_plan FROM users WHERE id = :id', { id: uid }))[0];
    assert.equal(u.subscription_status, 'active', 'active event stores active');
    n++;
    await billing.syncSubscription(sub('canceled'));
    u = (await query('SELECT subscription_status, billing_plan FROM users WHERE id = :id', { id: uid }))[0];
    assert.equal(u.subscription_status, 'canceled', 'deleted event stores canceled');
    n++;
    await billing.syncSubscription(sub('active'));
    u = (await query('SELECT subscription_status, billing_plan FROM users WHERE id = :id', { id: uid }))[0];
    assert.equal(u.subscription_status, 'canceled', 'STALE active event for the same sub id does not resurrect');
    n++;
    assert.equal(u.billing_plan, 'free', 'plan stays free after the stale event');
    n++;
    await billing.syncSubscription(sub('active', 'sub_143_new'));
    u = (await query('SELECT subscription_status, billing_plan FROM users WHERE id = :id', { id: uid }))[0];
    assert.equal(u.subscription_status, 'active', 'a NEW subscription id takes over normally');
    n++;
    group('Part 10 billing terminal guard', n);
  }
  {
    let n = 0;
    const { withJobLock } = require(path.join(root, 'server/jobExecutionLock.js'));
    const ran = await withJobLock(1, 999001, async () => 'ran');
    assert.equal(ran, 'ran', 'baseline lock acquires (creates the locks table)');
    n++;
    const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await query(
      'INSERT INTO job_execution_locks (workspace_id, job_id, owner, owner_pid, owner_host, claimed_at) VALUES (1, 999002, :owner, 999999, :host, :at)',
      { owner: 'staleowner143', host: 'dead-container-host', at: oldIso }
    );
    const reclaimed = await withJobLock(1, 999002, async () => 'reclaimed');
    assert.equal(reclaimed, 'reclaimed', 'a >24h foreign-host lock is reclaimable');
    n++;
    await query(
      'INSERT INTO job_execution_locks (workspace_id, job_id, owner, owner_pid, owner_host, claimed_at) VALUES (1, 999003, :owner, 999999, :host, :at)',
      { owner: 'freshowner143', host: 'live-container-host', at: new Date().toISOString() }
    );
    let code = '';
    try {
      await withJobLock(1, 999003, async () => 'nope');
    } catch (e) {
      code = e.code || '';
    }
    assert.equal(code, 'JOB_RUNNING', 'a fresh foreign-host lock still fails closed');
    n++;
    group('Part 11 job lock reclaim', n);
  }
  console.log(`\nbatch143-review-fixes-regressions: ALL ${groups.length} groups passed`);
  for (const g of groups) console.log(`  - ${g}`);
})().catch((e) => {
  console.error('batch143 suite FAILED:', e);
  process.exit(1);
});
