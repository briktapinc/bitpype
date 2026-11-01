'use strict';
/**
 * Batch 66 — per-record delete for Bookings Services + Modules
 * (Ely, 2026-10-29: "Add per record delete for that and modules",
 * continuing the Batch 45/51/65 rule that record types which pile up
 * get per-record deletes).
 *
 * (A) SERVICES — DELETE /api/v1/admin-area/bookings/services/:id
 *   Appointments reference a service by a bare service_id FK (no
 *   REFERENCES clause, no denormalized name on the bookings table),
 *   so the delete:
 *     - BLOCKS with 409 SERVICE_HAS_UPCOMING while the service has
 *       upcoming appointments (status pending/confirmed, starts_at in
 *       the future, not archived) — nothing is written;
 *     - otherwise SNAPSHOTS the service name + duration onto every
 *       appointment row first (new bookings.service_name_snapshot /
 *       service_duration_snapshot columns; the three appointment
 *       readers COALESCE snapshot → live service), then deletes.
 *   There are no service-scoped schedule rows in the schema —
 *   booking_hours / booking_blocks are lead-scoped and stay.
 *   Guard: owner/admin session (Batch 53 census pattern); tokens get
 *   TOKEN_ROLE_DENIED; an activity_log audit row is written.
 *
 * (B) MODULES — DELETE /api/v1/admin-area/modules/installs/:leadId/:type
 *   and portal DELETE /api/v1/portal/modules/:type.
 *   The data model scopes ALL module content by (lead_id, type) and
 *   site_module_embeds is UNIQUE(lead_id, module_type) — the single
 *   embed IS the module instance, so delete = remove the embed AND
 *   purge that lead+type's content/config rows, then re-sync the
 *   site's pages (managed blocks for the module are stripped, like
 *   detach). Detach itself is untouched and keeps content. Records a
 *   module merely COLLECTED stay (ecommerce_orders, call_logs,
 *   calls_billing — Batch 45/51 keep their own per-record paths);
 *   pooled Twilio numbers are released implicitly because
 *   findNumberClaim derives claims from calltracking_configs.
 *   Bookings module delete carries the same upcoming guard
 *   (MODULE_HAS_UPCOMING). Portal delete is owner-only (renters get
 *   403 MODULE_DELETE_OWNER_ONLY even for modules in their set).
 *
 * NEGATIVE PROOFS (env flags; Part A block/retention checks must go
 * red and this file must exit non-zero):
 *   B66_NEG_PROOF=upcoming — both upcoming guards neutered in a
 *     mutated copy of siteModules.js → A2/A6 block checks fail.
 *   B66_NEG_PROOF=scope — the faq purge step also purges testimonials
 *     in the mutated copy → A4 retention checks fail.
 *
 * Harness: engine checks in-process on a temp workspace DB + HTTP
 * role matrix against the real server booted on the same temp dirs
 * (batch62 pattern). DB_DRIVER=sqlite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b66-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch66', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 17).toString('base64');

const NEG = process.env.B66_NEG_PROOF || '';
const PORT = 31466;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch66', 'fixture', 'password'].join('-');
const LEAD_A = 6601;
const LEAD_B = 6602;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
    console.log('ok -', name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.error('FAIL -', name, '\n ', e && e.message);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('ok -', name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.error('FAIL -', name, '\n ', e && e.message);
  }
}

/** The module under test: the real siteModules, or a mutated copy for
 * the negative proofs (written beside the original so its relative
 * requires resolve identically; removed immediately after require). */
function loadSiteModules() {
  const realPath = path.join(root, 'server/siteModules.js');
  if (!NEG) return require(realPath);
  const src = fs.readFileSync(realPath, 'utf8');
  let mutated = src;
  if (NEG === 'upcoming') {
    mutated = mutated.replace(
      'const upcoming = listUpcomingAppointments(db, leadId, row.id);',
      'const upcoming = []; // B66 NEGATIVE: service guard removed'
    );
    mutated = mutated.replace(
      'const upcoming = listUpcomingAppointments(db, lid);',
      'const upcoming = []; // B66 NEGATIVE: module guard removed'
    );
    assert.notEqual(mutated, src, 'upcoming negative mutation must apply');
    assert.ok(!mutated.includes('const upcoming = listUpcomingAppointments'), 'both guards neutered');
  } else if (NEG === 'scope') {
    const needle = "return [byLead('faq_items', 'FAQ items')];";
    assert.ok(src.includes(needle), 'scope negative mutation marker present');
    mutated = src.replace(
      needle,
      "return [byLead('faq_items', 'FAQ items'), byLead('testimonials', 'testimonials')]; // B66 NEGATIVE: purge escapes its type"
    );
  } else {
    throw new Error('unknown B66_NEG_PROOF=' + NEG);
  }
  const tmpFile = path.join(root, 'server/siteModules.b66neg.js');
  fs.writeFileSync(tmpFile, mutated);
  try {
    return require(tmpFile);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
const FUTURE = fmtLocal(new Date(Date.now() + 2 * 24 * 3600 * 1000));

/* ==================================================================== */
/* Part A — engine level                                                 */
/* ==================================================================== */

let WS_ID;
async function partA() {
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = loadSiteModules();

  const a = await workspace.createUserWithWorkspace({
    email: 'a66@example.invalid',
    password: PW,
    name: 'A66',
    workspaceName: 'Batch66 WS',
  });
  WS_ID = Number(a.workspaceId);
  const db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);

  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A, 'B66 Alpha', 'alpha66@example.invalid', 'customer'
  );
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_B, 'B66 Beta', 'beta66@example.invalid', 'customer'
  );
  const homeHtml =
    '<!doctype html><html><body><header>Alpha nav</header><main><h1>Alpha</h1><p>Welcome.</p></main><footer>Alpha footer</footer></body></html>';
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A, 'Alpha Site', '{}', JSON.stringify([{ slug: 'home', title: 'Home', html: homeHtml }]), 'draft'
  );

  const count = (sql, ...p) => db.prepare(sql).get(...p).c;
  const insBooking = db.prepare(
    `INSERT INTO bookings (lead_id, service_id, customer_name, customer_email, starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  /* ---- A1: service delete happy path + snapshot + sweep ---- */
  const svc = sm.createBookingService(db, LEAD_A, { name: 'Alpha Cut', duration_minutes: 45, status: 'published' });
  insBooking.run(LEAD_A, svc.id, 'Past One', 'p1@x.invalid', '2020-01-01T10:00:00', '2020-01-01T10:45:00', 'completed');
  insBooking.run(LEAD_A, svc.id, 'Past Two', 'p2@x.invalid', '2020-01-02T10:00:00', '2020-01-02T10:45:00', 'confirmed');
  insBooking.run(LEAD_A, svc.id, 'Cancelled Future', 'p3@x.invalid', FUTURE, FUTURE, 'cancelled');
  const hoursBefore = count('SELECT COUNT(*) AS c FROM booking_hours WHERE lead_id = ?', LEAD_A);

  let outA1;
  check('A1a: service with only past/cancelled appointments deletes', () => {
    outA1 = sm.deleteBookingService(db, LEAD_A, svc.id);
    assert.equal(outA1.deleted, true);
    assert.equal(outA1.name, 'Alpha Cut');
  });
  check('A1b: all 3 appointments snapshotted with name + duration before the delete', () => {
    assert.equal(outA1.past_appointments_snapshotted, 3);
    const rows = db.prepare('SELECT * FROM bookings WHERE lead_id = ? AND service_id = ?').all(LEAD_A, svc.id);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.service_name_snapshot, 'Alpha Cut');
      assert.equal(r.service_duration_snapshot, 45);
    }
  });
  check('A1c: service row gone; appointment lists still read the service name (COALESCE)', () => {
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_services WHERE id = ?', svc.id), 0);
    const appts = sm.listAppointments(db, LEAD_A, {});
    const mine = appts.filter((x) => x.service_id === svc.id);
    assert.equal(mine.length, 3);
    assert.ok(mine.every((x) => x.service_name === 'Alpha Cut' && x.service_duration === 45));
  });
  check('A1d: orphan sweep — no appointment references the deleted service without a snapshot', () => {
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM bookings WHERE service_id = ? AND COALESCE(service_name_snapshot, '') = ''",
        svc.id
      ),
      0
    );
  });
  check('A1e: lead-scoped schedule rows are NOT service-scoped — untouched by a service delete', () => {
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_hours WHERE lead_id = ?', LEAD_A), hoursBefore);
  });

  /* ---- A2: upcoming guard (service) ---- */
  const svc2 = sm.createBookingService(db, LEAD_A, { name: 'Alpha Wash', duration_minutes: 30, status: 'published' });
  insBooking.run(LEAD_A, svc2.id, 'Future Confirmed', 'f1@x.invalid', FUTURE, FUTURE, 'confirmed');
  insBooking.run(LEAD_A, svc2.id, 'Old One', 'f2@x.invalid', '2020-03-01T09:00:00', '2020-03-01T09:30:00', 'completed');
  check('A2a: upcoming confirmed appointment BLOCKS the service delete (409 SERVICE_HAS_UPCOMING)', () => {
    assert.throws(
      () => sm.deleteBookingService(db, LEAD_A, svc2.id),
      (e) => e.code === 'SERVICE_HAS_UPCOMING' && e.status === 409 && /1 upcoming appointment/.test(e.message)
    );
  });
  check('A2b: the blocked delete wrote NOTHING (service intact, no snapshot, bookings intact)', () => {
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_services WHERE id = ?', svc2.id), 1);
    const rows = db.prepare('SELECT * FROM bookings WHERE service_id = ?').all(svc2.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.service_name_snapshot && r.service_duration_snapshot == null));
  });

  /* ---- A3: pending blocks too; completed future does not ---- */
  const svc3 = sm.createBookingService(db, LEAD_A, { name: 'Alpha Detail', duration_minutes: 60, status: 'published' });
  const pendId = Number(
    insBooking.run(LEAD_A, svc3.id, 'Future Pending', 'f3@x.invalid', FUTURE, FUTURE, 'pending').lastInsertRowid
  );
  check('A3a: upcoming PENDING appointment also blocks', () => {
    assert.throws(() => sm.deleteBookingService(db, LEAD_A, svc3.id), (e) => e.code === 'SERVICE_HAS_UPCOMING');
  });
  check('A3b: once completed, the future appointment no longer blocks', () => {
    db.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").run(pendId);
    const out = sm.deleteBookingService(db, LEAD_A, svc3.id);
    assert.equal(out.deleted, true);
  });

  /* ---- A4: module delete — last-embed purge + retention + page sync ---- */
  sm.attachModule(db, LEAD_A, 'faq', { targetPageSlug: 'home', workspaceId: WS_ID });
  for (let i = 1; i <= 3; i++) {
    sm.createFaqItem(db, LEAD_A, { question: `Alpha Q${i}?`, answer: `Alpha A${i}`, status: 'published' });
  }
  for (let i = 1; i <= 2; i++) {
    sm.createFaqItem(db, LEAD_B, { question: `Beta Q${i}?`, answer: `Beta A${i}`, status: 'published' });
  }
  sm.ensureEmbed(db, LEAD_A, 'testimonials', { workspaceId: WS_ID });
  sm.createTestimonial(db, LEAD_A, { quote: 'Great!', author: 'Fan One', status: 'published' });
  sm.createTestimonial(db, LEAD_A, { quote: 'Superb!', author: 'Fan Two', status: 'published' });

  const pagesBefore = db.prepare('SELECT pages FROM websites WHERE lead_id = ?').get(LEAD_A).pages;
  check('A4a: fixture — the faq module is mounted on the site pages', () => {
    assert.ok(pagesBefore.includes('data-bitpype-module'), 'managed module block present in pages');
  });
  check('A4b: moduleContentCounts reports the real purge preview (3 FAQ items)', () => {
    const c = sm.moduleContentCounts(db, LEAD_A, 'faq');
    assert.equal(c.total, 3);
    assert.deepEqual(c.parts, [{ table: 'faq_items', label: 'FAQ items', count: 3 }]);
  });
  let outA4;
  check('A4c: deleteModule purges embed + content and reports the counts', () => {
    outA4 = sm.deleteModule(db, LEAD_A, 'faq');
    assert.equal(outA4.deleted, true);
    assert.equal(outA4.purged.faq_items, 3);
    assert.equal(count('SELECT COUNT(*) AS c FROM faq_items WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?', LEAD_A, 'faq'), 0);
  });
  check('A4d: retention — other lead and other module type are untouched', () => {
    assert.equal(count('SELECT COUNT(*) AS c FROM faq_items WHERE lead_id = ?', LEAD_B), 2);
    assert.equal(count('SELECT COUNT(*) AS c FROM testimonials WHERE lead_id = ?', LEAD_A), 2);
    assert.equal(count('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?', LEAD_A, 'testimonials'), 1);
  });
  check('A4e: page sync stripped the deleted module’s managed block from the site', () => {
    const pagesAfter = db.prepare('SELECT pages FROM websites WHERE lead_id = ?').get(LEAD_A).pages;
    assert.ok(!pagesAfter.includes('data-bitpype-module="faq"'), 'faq block stripped');
  });

  /* ---- A5: detach keeps content; delete purges a detached embed too ---- */
  check('A5: detach ≠ delete — detach keeps content, delete purges the detached embed', () => {
    sm.detachModule(db, LEAD_A, 'testimonials');
    assert.equal(count('SELECT COUNT(*) AS c FROM testimonials WHERE lead_id = ?', LEAD_A), 2);
    const out = sm.deleteModule(db, LEAD_A, 'testimonials');
    assert.equal(out.purged.testimonials, 2);
    assert.equal(count('SELECT COUNT(*) AS c FROM testimonials WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?', LEAD_A, 'testimonials'), 0);
  });

  /* ---- A6: bookings module — upcoming guard, then full purge ---- */
  sm.ensureEmbed(db, LEAD_A, 'bookings', { workspaceId: WS_ID });
  const svcB = sm.createBookingService(db, LEAD_A, { name: 'Alpha Book', duration_minutes: 30, status: 'published' });
  const upId = Number(
    insBooking.run(LEAD_A, svcB.id, 'Module Future', 'm1@x.invalid', FUTURE, FUTURE, 'confirmed').lastInsertRowid
  );
  check('A6a: bookings module delete BLOCKS on upcoming appointments (MODULE_HAS_UPCOMING), deletes nothing', () => {
    assert.throws(
      () => sm.deleteModule(db, LEAD_A, 'bookings'),
      (e) => e.code === 'MODULE_HAS_UPCOMING' && e.status === 409
    );
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_services WHERE lead_id = ?', LEAD_A), 2);
    assert.equal(count('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?', LEAD_A, 'bookings'), 1);
  });
  check('A6b: after cancelling, the module purge clears services/bookings/hours/blocks/settings + embed', () => {
    // The module guard is lead-wide: svc2's future booking (A2) also
    // blocks until cancelled — cancel every live booking for the lead.
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE lead_id = ?").run(LEAD_A);
    assert.equal(sm.listUpcomingAppointments(db, LEAD_A).length, 0);
    const out = sm.deleteModule(db, LEAD_A, 'bookings');
    assert.equal(out.deleted, true);
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_services WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM bookings WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_hours WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_blocks WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM booking_settings WHERE lead_id = ?', LEAD_A), 0);
    assert.equal(count('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?', LEAD_A, 'bookings'), 0);
  });

  /* ---- A7: calltracking — pool claim released, call logs kept ---- */
  const POOL_NUM = '+15556660001';
  db.prepare(
    'INSERT INTO calltracking_configs (lead_id, display_number, redirect_number) VALUES (?, ?, ?)'
  ).run(LEAD_A, POOL_NUM, '+16105550199');
  db.prepare(
    `INSERT INTO call_logs (lead_id, call_sid, from_number, to_number, status, duration_seconds)
     VALUES (?, 'CA66fixture', '+16105550100', ?, 'completed', 42)`
  ).run(LEAD_A, POOL_NUM);
  sm.ensureEmbed(db, LEAD_A, 'calltracking', { workspaceId: WS_ID });
  check('A7a: fixture — the pooled number is claimed by lead A', () => {
    const claim = sm.findNumberClaim(db, POOL_NUM);
    assert.ok(claim && claim.lead_id === LEAD_A);
  });
  check('A7b: calltracking delete releases the pool claim; collected call logs stay', () => {
    const out = sm.deleteModule(db, LEAD_A, 'calltracking');
    assert.equal(out.purged.calltracking_configs, 1);
    assert.equal(sm.findNumberClaim(db, POOL_NUM), null);
    assert.equal(count('SELECT COUNT(*) AS c FROM call_logs WHERE lead_id = ?', LEAD_A), 1);
    assert.equal(count('SELECT COUNT(*) AS c FROM calltracking_configs WHERE lead_id = ?', LEAD_A), 0);
  });

  /* ---- A8: not-found contracts ---- */
  check('A8: deleting what is not there is a coded 404, on both surfaces', () => {
    assert.throws(() => sm.deleteModule(db, LEAD_A, 'blog'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
    assert.throws(() => sm.deleteBookingService(db, LEAD_A, 999999), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  });

  return { db };
}

/* ==================================================================== */
/* Part B — HTTP role matrix + audit rows                                */
/* ==================================================================== */

function makeJar() {
  // Batch62's jar, verbatim: the x-forwarded-proto header matters —
  // without it the Secure session cookie never round-trips over the
  // test's plain-http BASE and the MFA challenge session is lost.
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

async function partB(db) {
  const platformDb = require(path.join(root, 'server/db.js'));
  const q = platformDb.query;
  const workspace = require(path.join(root, 'server/workspace.js'));
  const bcrypt = require('bcryptjs');
  const totp = require(path.join(root, 'src/totp.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));

  // Member of the fixture workspace (role gate target).
  const memberIns = await q(
    'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
    { e: 'member66@example.invalid', h: bcrypt.hashSync(PW, 12), n: 'Member66', s: 'active' }
  );
  await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', {
    w: WS_ID, u: Number(memberIns.insertId), r: 'member',
  });
  const { token: WS_TOKEN } = await workspace.createWorkspaceToken(WS_ID, 'batch66-test');

  // HTTP fixtures: one service + two module installs on lead A.
  const svcHttp = sm.createBookingService(db, LEAD_A, { name: 'HTTP Cut', duration_minutes: 30, status: 'published' });
  const svcHttp2 = sm.createBookingService(db, LEAD_A, { name: 'HTTP Wash', duration_minutes: 30, status: 'published' });
  sm.ensureEmbed(db, LEAD_A, 'events', { workspaceId: WS_ID });
  sm.createEvent(db, LEAD_A, { title: 'Launch Day', starts_at: '2030-01-01T10:00:00', status: 'published' });
  sm.ensureEmbed(db, LEAD_A, 'blog', { workspaceId: WS_ID });
  sm.createBlogPost(db, LEAD_A, { title: 'Hello', body: 'World', status: 'published' });

  // Portal fixtures (platform DB): plan-link platform users + portal
  // users — owner and renter on the SAME lead (usertypes pattern).
  for (const email of ['owner66@example.invalid', 'renter66@example.invalid']) {
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: email, h: bcrypt.hashSync('UnusedPass66!', 12), n: 'B66 Portal Link', s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', :t)`,
      {
        e: email, h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B66 Alpha',
        t: email.startsWith('owner') ? 'owner' : 'renter',
      }
    );
  }
  // Portal fixtures: the renter test uses calltracking (in the renter
  // module set, so the module guard passes and the OWNER check is what
  // fires); the owner test uses a fresh events install.
  db.prepare(
    'INSERT INTO calltracking_configs (lead_id, display_number, redirect_number) VALUES (?, ?, ?)'
  ).run(LEAD_A, '+15556660002', '+16105550199');
  sm.ensureEmbed(db, LEAD_A, 'calltracking', { workspaceId: WS_ID });

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

    const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    async function staffSession(email) {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email, password: PW });
      let body = await json(res);
      assert(res.status === 200 && body.data && body.data.mfaRequired === true, `login challenge for ${email}`);
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data && body.data.secret;
      assert(secret, 'enroll start returns a secret');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data && body.data.user, `session for ${email}`);
      return jar;
    }
    const ownerJar = await staffSession('a66@example.invalid');
    const memberJar = await staffSession('member66@example.invalid');
    const del = (jar, p) => jar.fetch(BASE + p, { method: 'DELETE' });
    const asToken = (p, method) =>
      fetch(BASE + p, { method, headers: { authorization: `Bearer ${WS_TOKEN}` } });

    await acheck('B1: member session is refused the service delete (403, service intact)', async () => {
      const res = await del(memberJar, `/api/v1/admin-area/bookings/services/${svcHttp.id}?leadId=${LEAD_A}`);
      assert.equal(res.status, 403);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM booking_services WHERE id = ?').get(svcHttp.id).c, 1);
    });
    await acheck('B2: workspace token is refused the service delete (403 TOKEN_ROLE_DENIED)', async () => {
      const res = await asToken(`/api/v1/admin-area/bookings/services/${svcHttp.id}?leadId=${LEAD_A}`, 'DELETE');
      const body = await json(res);
      assert.equal(res.status, 403);
      assert.equal(body.code, 'TOKEN_ROLE_DENIED');
    });
    await acheck('B3: owner session deletes the service (200) and an audit row lands', async () => {
      const res = await del(ownerJar, `/api/v1/admin-area/bookings/services/${svcHttp.id}?leadId=${LEAD_A}`);
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.deleted, true);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM booking_services WHERE id = ?').get(svcHttp.id).c, 0);
      const log = db
        .prepare("SELECT * FROM activity_log WHERE area = 'bookings' AND message LIKE '%deleted service%' ORDER BY id DESC")
        .get();
      assert.ok(log && log.message.includes('HTTP Cut'), 'audit row names the service');
    });
    await acheck('B4: member + token are refused the module-install delete (403)', async () => {
      const r1 = await del(memberJar, `/api/v1/admin-area/modules/installs/${LEAD_A}/events`);
      assert.equal(r1.status, 403);
      const r2 = await asToken(`/api/v1/admin-area/modules/installs/${LEAD_A}/events`, 'DELETE');
      assert.equal(r2.status, 403);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?').get(LEAD_A, 'events').c,
        1
      );
    });
    await acheck('B5: owner session deletes the module install (200, content purged, audit row)', async () => {
      const res = await del(ownerJar, `/api/v1/admin-area/modules/installs/${LEAD_A}/events`);
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.purged.events, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events WHERE lead_id = ?').get(LEAD_A).c, 0);
      const log = db
        .prepare("SELECT * FROM activity_log WHERE area = 'modules' AND message LIKE '%deleted the events module%' ORDER BY id DESC")
        .get();
      assert.ok(log, 'modules audit row written');
      // The untouched second service + blog install survive.
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM booking_services WHERE id = ?').get(svcHttp2.id).c, 1);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?').get(LEAD_A, 'blog').c,
        1
      );
    });

    /* ---- portal surface ---- */
    async function portalSession(email) {
      const jar = makeJar();
      const res = await post(jar, '/api/v1/portal/login', { email, password: PW });
      assert.equal(res.status, 200, `portal login for ${email}`);
      return jar;
    }
    const portalOwner = await portalSession('owner66@example.invalid');
    const portalRenter = await portalSession('renter66@example.invalid');

    await acheck('B6: renter is refused the portal module delete (403 owner-only), config intact', async () => {
      const res = await del(portalRenter, '/api/v1/portal/modules/calltracking');
      const body = await json(res);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(body.code, 'MODULE_DELETE_OWNER_ONLY');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM calltracking_configs WHERE lead_id = ?').get(LEAD_A).c, 1);
    });
    await acheck('B7: portal owner deletes the module (200) — embed + config purged', async () => {
      const res = await del(portalOwner, '/api/v1/portal/modules/calltracking');
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM calltracking_configs WHERE lead_id = ?').get(LEAD_A).c, 0);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM site_module_embeds WHERE lead_id = ? AND module_type = ?').get(LEAD_A, 'calltracking').c,
        0
      );
    });
    await acheck('B8: portal delete of a module that is not installed is a coded 404', async () => {
      const res = await del(portalOwner, '/api/v1/portal/modules/googlereviews');
      const body = await json(res);
      assert.equal(res.status, 404, JSON.stringify(body));
      assert.equal(body.code, 'NOT_FOUND');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

/* ==================================================================== */

(async () => {
  let ctx;
  try {
    ctx = await partA();
  } catch (e) {
    console.error('Part A setup failed:', e);
    results.push(['FAIL', 'Part A setup']);
  }
  if (ctx && !NEG) {
    try {
      await partB(ctx.db);
    } catch (e) {
      console.error('Part B failed:', e);
      results.push(['FAIL', 'Part B harness']);
    }
  }
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(`\nBatch 66: ${results.length - failed.length}/${results.length} checks passed.`);
  if (NEG) console.log(`(negative proof mode: B66_NEG_PROOF=${NEG} — failures above are EXPECTED)`);
  process.exit(failed.length ? 1 : 0);
})();
