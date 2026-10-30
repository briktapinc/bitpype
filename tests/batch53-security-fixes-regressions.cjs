'use strict';
/**
 * Batch 53 — security fixes from the 2026-10-29 expert review.
 *
 *   FIX 1 (E-1, HIGH) — the public claim endpoint treated ANY
 *   unrecognised/missing `action` as "interested" (src/outreach.js
 *   applyClaimResponse fell through), so a garbage POST with a lead's
 *   public claim token forged engagement and dispatched a real
 *   follow-up email. Now: strict allow-list (the shipped claim page +
 *   preview popup send interested|uninterested|later; yes/no/deferred/
 *   maybe/maybe_later are the engine's historical synonyms). Unknown or
 *   missing → VALIDATION (HTTP 400 at the route), zero state change,
 *   zero dispatches, one forensic activity_log row. Enforced in the
 *   engine AND asserted again in domain.outreachClaimDecide.
 *
 *   FIX 2 (E-2, HIGH) — DELETE /leads/:id and DELETE /websites/:id had
 *   no role gate: the workspace bearer token (and a staff `member`)
 *   could permanently destroy data. Both now carry
 *   requireRole('owner','admin') — the identical gate their siblings
 *   (website purge, Batch 45/51 admin-area deletes) already had. The
 *   route census found the same gap on every other destructive staff
 *   route, and those are gated too: DELETE /design/:id,
 *   DELETE /design/:id/delivery + POST /design/:id/remove-delivery
 *   (same operation, two verbs), DELETE /campaigns/:id,
 *   DELETE /templates/:id, DELETE /suppression/:id,
 *   POST /leads/merge (folds + deletes leads), and POST /leads/bulk
 *   when action='delete' (conditional gate — the other bulk actions
 *   keep their existing access). MCP facade tools call the domain layer
 *   directly and are unaffected (proven below at the facade level).
 *
 *   FIX 3 (E-4, MEDIUM) — POST /auth/register issued a full staff
 *   session on password alone while login parks an MFA challenge
 *   (Batch 40: TOTP required for staff). Register now parks the same
 *   challenge (stage from mfa.getState; 'enroll' for a new account) and
 *   the session is issued only by finishStaffLogin after enrollment —
 *   mirroring login exactly. The client routes register's challenge
 *   through renderAuthMfa and a pending invite survives the detour.
 *   (The client portal has no registration route at all — nothing to
 *   change there; portal MFA stays opt-in per Batch 40.)
 *
 *   NEGATIVE PROOF: B53_NEGATIVE=1 swaps src/outreach.js for a scratch
 *   copy whose applyClaimResponse restores the pre-fix fall-through
 *   (unknown → 'interested'); the claim rejection checks MUST fail.
 *
 * Harness: engine tests on in-memory sqlite (claim-hold pattern) +
 * HTTP tests against the real server booted on a temp platform DB
 * (mfa-totp pattern). Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b53-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch53', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const NEGATIVE = process.env.B53_NEGATIVE === '1';
const PORT = 31453;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fnOrCond) {
  // Both call styles are used below: boolean conditions (route pins)
  // and function bodies (engine checks). A function MUST be invoked —
  // asserting on the function object itself would pass vacuously.
  if (typeof fnOrCond === 'function') fnOrCond();
  else assert(fnOrCond, name);
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected throw with code ${code}`);
}

/* ===================================================================== */
/* Part A — claim allow-list, engine level                                */
/* ===================================================================== */

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

function loadOutreach() {
  if (!NEGATIVE) return require(path.join(root, 'src/outreach.js'));
  // Pre-fix shim: unknown actions fall through to 'interested', exactly
  // like the handler the review exploited. Written as a sibling of the
  // real module so its relative requires resolve identically; removed
  // again in main()'s finally.
  const src = fs.readFileSync(path.join(root, 'src/outreach.js'), 'utf8');
  const marker = 'const claimAct = assertClaimAction(db, leadId, action);';
  assert(src.includes(marker), 'shim marker not found in src/outreach.js');
  const shimmed = src.replace(
    marker,
    "const claimAct = normalizeClaimAction(action) || 'interested'; // B53_NEGATIVE pre-fix shim"
  );
  const shimPath = path.join(root, 'src/.b53-negative-outreach.js');
  fs.writeFileSync(shimPath, shimmed);
  return require(shimPath);
}

function partA() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  require(path.join(root, 'src/websiteEngine.js')).ensureTables(db);
  const outreach = loadOutreach();
  outreach.ensureTables(db);

  // Follow-up dispatch seam: replicate server/interestedFollowup.js —
  // the listener claims the durable marker synchronously, then "sends".
  let sends = 0;
  outreach.setInterestedListener(({ db: ldb, leadId }) => {
    const claimed = ldb
      .prepare('SELECT id FROM prospect_events WHERE lead_id = ? AND type = ? LIMIT 1')
      .get(leadId, 'email.followup_dispatched');
    if (claimed) return;
    outreach.recordIntent(ldb, leadId, 'email.followup_dispatched', 'stub dispatch');
    sends++;
  });

  const mkLead = (name) =>
    Number(
      db
        .prepare('INSERT INTO leads (business_name, email, status) VALUES (?, ?, ?)')
        .run(name, `${name.toLowerCase().replace(/\s+/g, '.')}@example.invalid`, 'new').lastInsertRowid
    );
  const status = (id) => db.prepare('SELECT status FROM leads WHERE id = ?').get(id).status;
  const events = (id, type) =>
    Number(
      db.prepare('SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = ?').get(id, type).c
    );

  check('normalizeClaimAction: canonical values map to their families', () => {
    assert.equal(outreach.normalizeClaimAction('interested'), 'interested');
    assert.equal(outreach.normalizeClaimAction('uninterested'), 'uninterested');
    assert.equal(outreach.normalizeClaimAction('later'), 'later');
  });
  check('normalizeClaimAction: historical synonyms survive (yes/no/deferred/maybe/maybe_later)', () => {
    assert.equal(outreach.normalizeClaimAction('yes'), 'interested');
    assert.equal(outreach.normalizeClaimAction(' YES '), 'interested');
    assert.equal(outreach.normalizeClaimAction('no'), 'uninterested');
    assert.equal(outreach.normalizeClaimAction('deferred'), 'later');
    assert.equal(outreach.normalizeClaimAction('maybe'), 'later');
    assert.equal(outreach.normalizeClaimAction('maybe_later'), 'later');
  });
  check('normalizeClaimAction: garbage / empty / missing → null', () => {
    assert.equal(outreach.normalizeClaimAction('QA-REVIEW-invalid'), null);
    assert.equal(outreach.normalizeClaimAction('garbage'), null);
    assert.equal(outreach.normalizeClaimAction(''), null);
    assert.equal(outreach.normalizeClaimAction(undefined), null);
    assert.equal(outreach.normalizeClaimAction(null), null);
  });

  check('interested → engaged + event + exactly one dispatch; repeat is idempotent', () => {
    const id = mkLead('Alpha');
    const r1 = outreach.applyClaimResponse(db, id, 'interested');
    assert.equal(r1.action, 'interested');
    assert.equal(r1.already, false);
    assert.equal(status(id), 'engaged');
    assert.equal(events(id, 'email.interested'), 1);
    assert.equal(sends, 1);
    const r2 = outreach.applyClaimResponse(db, id, 'interested');
    assert.equal(r2.already, true);
    assert.equal(status(id), 'engaged');
    assert.equal(sends, 1, 'second interested click must not re-dispatch');
  });
  check("'yes' behaves as interested", () => {
    const id = mkLead('Bravo');
    const r = outreach.applyClaimResponse(db, id, 'yes');
    assert.equal(r.action, 'interested');
    assert.equal(status(id), 'engaged');
    assert.equal(sends, 2);
  });
  check("uninterested → lost + suppression; 'no' is the same family", () => {
    const id = mkLead('Charlie');
    const r = outreach.applyClaimResponse(db, id, 'uninterested');
    assert.equal(r.action, 'uninterested');
    assert.equal(status(id), 'lost');
    const sup = db.prepare('SELECT reason FROM suppression_list WHERE email = ?').get('charlie@example.invalid');
    assert(sup && sup.reason === 'do-not-contact', 'suppression row written');
    const id2 = mkLead('Delta');
    assert.equal(outreach.applyClaimResponse(db, id2, 'no').action, 'uninterested');
    assert.equal(status(id2), 'lost');
  });
  check('later family defers without touching status', () => {
    for (const [name, action] of [
      ['Echo', 'later'],
      ['Foxtrot', 'maybe'],
      ['Golf', 'deferred'],
      ['Hotel', 'maybe_later'],
    ]) {
      const id = mkLead(name);
      const r = outreach.applyClaimResponse(db, id, action);
      assert.equal(r.action, 'later', action);
      assert.equal(r.deferred, true, action);
      assert.equal(status(id), 'new', action);
      assert.equal(events(id, 'claim.later'), 1, action);
    }
    assert.equal(sends, 2, 'later never dispatches the follow-up');
  });

  const rejectionInvariants = (name, action) => {
    const id = mkLead(name);
    const before = sends;
    throwsCode(() => outreach.applyClaimResponse(db, id, action), 'VALIDATION');
    assert.equal(status(id), 'new', 'status untouched');
    assert.equal(events(id, 'email.interested'), 0, 'no interested event');
    assert.equal(events(id, 'email.followup_dispatched'), 0, 'no dispatch marker');
    assert.equal(sends, before, 'no dispatch');
    const row = db
      .prepare('SELECT message FROM activity_log WHERE area = ? AND message LIKE ?')
      .get('outreach', `%Claim action rejected for lead #${id}%`);
    assert(row, 'forensic activity row written');
  };
  check('garbage action → VALIDATION + no state change + no dispatch + forensic row', () =>
    rejectionInvariants('India', 'QA-REVIEW-invalid'));
  check('missing action → VALIDATION + no state change + no dispatch + forensic row', () =>
    rejectionInvariants('Juliett', undefined));
  check('empty action → VALIDATION', () => rejectionInvariants('Kilo', ''));
}

/* ===================================================================== */
/* Part B — structural pins (routes, register, client)                    */
/* ===================================================================== */

function partB() {
  const api = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const gated = (pattern, label) =>
    check(`route carries requireRole('owner','admin'): ${label}`, pattern.test(api));

  gated(/router\.delete\('\/leads\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /leads/:id');
  gated(/router\.delete\('\/websites\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /websites/:id');
  gated(/router\.delete\('\/design\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /design/:id');
  gated(/router\.delete\('\/design\/:id\/delivery', requireRole\('owner', 'admin'\)/, 'DELETE /design/:id/delivery');
  gated(/router\.post\('\/design\/:id\/remove-delivery', requireRole\('owner', 'admin'\)/, 'POST /design/:id/remove-delivery');
  gated(/router\.delete\('\/campaigns\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /campaigns/:id');
  gated(/router\.delete\('\/templates\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /templates/:id');
  gated(/router\.delete\('\/suppression\/:id', requireRole\('owner', 'admin'\)/, 'DELETE /suppression/:id');
  gated(/router\.post\('\/leads\/merge', requireRole\('owner', 'admin'\)/, 'POST /leads/merge');

  check('bulk lead delete is conditionally gated (other bulk actions untouched)', () => {
    assert(api.includes('gateBulkLeadDelete'), 'gate helper defined');
    assert(/router\.post\('\/leads\/bulk', denyLeadScopedToken, gateBulkLeadDelete/.test(api));
    const helper = api.slice(api.indexOf('const gateBulkLeadDelete'), api.indexOf('const scopeLeadParam'));
    assert(helper.includes("requireRole('owner', 'admin')"), 'helper applies the owner/admin gate');
    assert(helper.includes("action || '') === 'delete'"), 'helper triggers only on the delete action');
  });

  check('census pin: every DELETE in domainApi is owner/admin-gated (social accounts = deliberate member exception)', () => {
    // Slice each registration up to the next one; the middleware chain
    // always precedes the handler within the first few hundred chars.
    const starts = [...api.matchAll(/router\.delete\(\s*'([^']+)'/g)];
    assert(starts.length >= 14, `expected the full DELETE census, found ${starts.length}`);
    for (const m of starts) {
      const routePath = m[1];
      const next = api.indexOf('\nrouter.', m.index + 1);
      const head = api.slice(m.index, next === -1 ? m.index + 1500 : next).slice(0, 400);
      if (routePath === '/social/accounts/:id') {
        assert(head.includes("requireRole('owner', 'admin', 'member')"), 'social accounts keeps its deliberate member-inclusive gate');
      } else {
        assert(
          head.includes("requireRole('owner', 'admin')"),
          `DELETE ${routePath} must carry requireRole('owner','admin')`
        );
      }
    }
  });

  check('MCP facade twins for the gated deletes still exist (facade layer is the agent path)', () => {
    const mcp = fs.readFileSync(path.join(root, 'server/mcp.js'), 'utf8');
    for (const needle of ['designDelete', 'designRemoveDelivery', 'campaignsDelete', 'templatesDelete', 'suppressionRemove', 'leadsMerge']) {
      assert(mcp.includes(needle), `server/mcp.js still wires ${needle}`);
    }
    const domain = require(path.join(root, 'server/domain.js'));
    for (const fn of ['leadsDelete', 'sitesDelete', 'designDelete', 'campaignsDelete', 'templatesDelete', 'suppressionRemove', 'leadsMerge']) {
      assert.equal(typeof domain[fn], 'function', `domain.${fn} remains a direct facade function`);
    }
  });

  const auth = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
  check('register parks an MFA challenge and never sets the session userId', () => {
    const start = auth.indexOf("router.post('/register'");
    const end = auth.indexOf("router.post('/login'");
    assert(start > -1 && end > start, 'register handler located');
    const handler = auth.slice(start, end);
    assert(!handler.includes('req.session.userId = created.userId'), 'register must not issue a session directly');
    assert(handler.includes('req.session.mfaChallenge = {'), 'register parks mfaChallenge');
    assert(handler.includes("stage: mfaState.enabled ? 'verify' : 'enroll'"), 'stage comes from mfa.getState, as in login');
    assert(handler.includes('mfaRequired: true'), 'register answers with the challenge shape');
  });

  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  check('client routes register challenges through renderAuthMfa and preserves invites', () => {
    assert(!app.includes("mode === 'login' && res.data && res.data.mfaRequired"), 'challenge branch is no longer login-only');
    assert(app.includes('if (res.data && res.data.mfaRequired)'), 'register responses reach renderAuthMfa');
    assert(app.includes('pendingInviteToken'), 'pending invite survives the MFA detour');
  });
}

/* ===================================================================== */
/* Part C — HTTP: role gates, register/MFA parity, claim over the wire    */
/* ===================================================================== */

const OWNER_EMAIL = 'owner53@example.invalid';
const ADMIN_EMAIL = 'admin53@example.invalid';
const MEMBER_EMAIL = 'member53@example.invalid';
const NEWBIE_EMAIL = 'newbie53@example.invalid';
const PW = ['batch53', 'fixture', 'password'].join('-');

function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) {
        headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
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

async function partC() {
  const bcrypt = require('bcryptjs');
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const totp = require(path.join(root, 'src/totp.js'));
  const outreach = require(path.join(root, 'src/outreach.js'));

  // ---- seed platform: one workspace, owner/admin/member, ws_ token ----
  const ownerCreated = await workspace.createUserWithWorkspace({
    email: OWNER_EMAIL,
    password: PW,
    name: 'Batch53 Owner',
    workspaceName: 'Batch53 Workspace',
  });
  const WS = Number(ownerCreated.workspaceId);
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  const mkUser = async (email, name, role) => {
    const ins = await platformDb.query(
      'INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)',
      { e: email, h: hash(PW), n: name, s: 'active' }
    );
    await platformDb.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', {
      w: WS,
      u: Number(ins.insertId),
      r: role,
    });
    return Number(ins.insertId);
  };
  await mkUser(ADMIN_EMAIL, 'Batch53 Admin', 'admin');
  await mkUser(MEMBER_EMAIL, 'Batch53 Member', 'member');
  const { token: WS_TOKEN } = await workspace.createWorkspaceToken(WS, 'batch53-test');

  // ---- seed workspace fixtures ----
  const wdb = openWorkspaceDb(WS);
  const mkLead = (name, email) =>
    Number(
      wdb
        .prepare('INSERT INTO leads (business_name, email, status) VALUES (?, ?, ?)')
        .run(name, email || `${name.toLowerCase().replace(/\s+/g, '.')}@example.invalid`, 'new').lastInsertRowid
    );
  const L_TOKEN = mkLead('Token Target'); // token delete attempt — must survive
  const L_MEMBER = mkLead('Member Target'); // member delete attempt — must survive
  const L_OWNER = mkLead('Owner Target'); // owner delete — succeeds
  const L_BULK = mkLead('Bulk Target'); // owner bulk delete — succeeds
  const L_KEEP = mkLead('Merge Keep');
  const L_DROP = mkLead('Merge Drop');
  const L_CLAIM = mkLead('Claim Biz', 'claim53@example.invalid');
  const L_SCRATCH = mkLead('Facade Scratch'); // in-process facade delete — succeeds
  const mkSite = (leadId, name) =>
    Number(
      wdb
        .prepare("INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, '{}', '[]', 'draft')")
        .run(leadId, name).lastInsertRowid
    );
  const W_TOKEN = mkSite(L_TOKEN, 'Token Site'); // token delete attempt — must survive
  const W_ADMIN = mkSite(L_MEMBER, 'Admin Site'); // admin delete — succeeds (archives)
  const template = domain.templatesSave(WS, { name: 'Batch53 Template', subject: 'Hi', body: 'Hello' });
  const TEMPLATE_ID = Number(template.id || (template.template && template.template.id) || domain.templatesList(WS, {})[0].id);
  const campaign = domain.campaignsCreate(WS, {
    name: 'Batch53 Campaign',
    templateId: TEMPLATE_ID,
    leadIds: [L_TOKEN],
  });
  const CAMPAIGN_ID = Number(campaign.id || (campaign.campaign && campaign.campaign.id));
  domain.suppressionAdd(WS, 'b53-suppress@example.invalid', 'do-not-contact');
  const SUPPRESSION_ID = Number(
    wdb.prepare('SELECT id FROM suppression_list WHERE email = ?').get('b53-suppress@example.invalid').id
  );
  const job = domain.designCreate(WS, {
    type: 'other',
    title: 'Batch53 Job',
    instructions: 'fixture job',
    leadId: L_TOKEN,
  });
  const JOB_ID = Number(job.id || (job.job && job.job.id));
  const job2 = domain.designCreate(WS, {
    type: 'other',
    title: 'Batch53 Job Two',
    instructions: 'facade delete fixture',
    leadId: L_TOKEN,
  });
  const JOB2_ID = Number(job2.id || (job2.job && job2.job.id));
  check('fixtures created (campaign/template/suppression/design ids resolved)', () =>
    assert(
      [CAMPAIGN_ID, TEMPLATE_ID, SUPPRESSION_ID, JOB_ID, JOB2_ID].every((n) => Number.isInteger(n) && n > 0),
      `ids: ${[CAMPAIGN_ID, TEMPLATE_ID, SUPPRESSION_ID, JOB_ID, JOB2_ID].join(',')}`
    )
  );
  // Stub mailer for the fixture workspace: no real SMTP is ever attempted.
  domain.settingsSet(WS, 'smtp.host', '');

  const leadRow = (id) => openWorkspaceDb(WS).prepare('SELECT id, status FROM leads WHERE id = ?').get(id);
  const siteRow = (id) =>
    openWorkspaceDb(WS).prepare('SELECT id, status, archived_at FROM websites WHERE id = ?').get(id);

  // ---- boot the real server ----
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
    const get = (jar, p) => jar.fetch(BASE + p);
    const asToken = (method, p, body) =>
      fetch(BASE + p, {
        method,
        headers: { authorization: `Bearer ${WS_TOKEN}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    const del = (jar, p) => jar.fetch(BASE + p, { method: 'DELETE' });

    // Full staff session via the Batch 40 flow: login → enroll → confirm.
    async function enrollSession(email) {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email, password: PW });
      let body = await json(res);
      assert(res.status === 200 && body.data.mfaRequired === true, `login challenge for ${email}`);
      assert.equal(body.data.mfaStage, 'enroll');
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data.secret;
      assert(secret, 'enroll start returns a secret');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert(res.status === 200 && body.data.user, `enroll confirm issues the session for ${email}`);
      return { jar, secret };
    }
    const owner = await enrollSession(OWNER_EMAIL);
    const admin = await enrollSession(ADMIN_EMAIL);
    const member = await enrollSession(MEMBER_EMAIL);
    check('staff sessions established for owner/admin/member via MFA enrollment', () => {});

    // ---------------- Fix 2: the delete-gate matrix ----------------
    await checkAsync('token DELETE /leads/:id → 403 TOKEN_ROLE_DENIED, lead survives', async () => {
      const res = await asToken('DELETE', `/api/v1/leads/${L_TOKEN}`);
      const body = await json(res);
      assert.equal(res.status, 403);
      assert.equal(body.code, 'TOKEN_ROLE_DENIED');
      assert(leadRow(L_TOKEN), 'lead must survive');
    });
    await checkAsync('token DELETE /websites/:id → 403 TOKEN_ROLE_DENIED, site survives', async () => {
      const res = await asToken('DELETE', `/api/v1/websites/${W_TOKEN}`);
      const body = await json(res);
      assert.equal(res.status, 403);
      assert.equal(body.code, 'TOKEN_ROLE_DENIED');
      assert(siteRow(W_TOKEN) && !siteRow(W_TOKEN).archived_at, 'site untouched');
    });
    await checkAsync('member DELETE /leads/:id → 403, lead survives', async () => {
      const res = await del(member.jar, `/api/v1/leads/${L_MEMBER}`);
      assert.equal(res.status, 403);
      assert(leadRow(L_MEMBER), 'lead must survive');
    });
    await checkAsync('member DELETE /websites/:id → 403, site survives', async () => {
      const res = await del(member.jar, `/api/v1/websites/${W_TOKEN}`);
      assert.equal(res.status, 403);
      assert(siteRow(W_TOKEN), 'site must survive');
    });
    await checkAsync('admin DELETE /websites/:id → 200 and the site is archived', async () => {
      const res = await del(admin.jar, `/api/v1/websites/${W_ADMIN}`);
      assert.equal(res.status, 200);
      const row = siteRow(W_ADMIN);
      assert(row && row.archived_at, `site archive-stamped (row: ${JSON.stringify(row)})`);
    });
    await checkAsync('owner DELETE /leads/:id → 200 (Batch 45 facade semantics intact)', async () => {
      const res = await del(owner.jar, `/api/v1/leads/${L_OWNER}`);
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert(!leadRow(L_OWNER), 'lead deleted');
    });
    await checkAsync('bulk delete action: token → 403, member → 403, owner → 200', async () => {
      let res = await asToken('POST', '/api/v1/leads/bulk', { action: 'delete', ids: [L_TOKEN] });
      assert.equal(res.status, 403);
      assert(leadRow(L_TOKEN), 'lead survives token bulk delete');
      res = await post(member.jar, '/api/v1/leads/bulk', { action: 'delete', ids: [L_MEMBER] });
      assert.equal(res.status, 403);
      assert(leadRow(L_MEMBER), 'lead survives member bulk delete');
      res = await post(owner.jar, '/api/v1/leads/bulk', { action: 'delete', ids: [L_BULK] });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert(!leadRow(L_BULK), 'owner bulk delete removed the lead');
    });
    await checkAsync('non-delete bulk actions keep existing access (member tag → 200)', async () => {
      const res = await post(member.jar, '/api/v1/leads/bulk', { action: 'tag', ids: [L_MEMBER], value: 'b53' });
      assert.equal(res.status, 200);
    });
    await checkAsync('merge: token → 403, member → 403, owner → 200 (drop lead folded away)', async () => {
      let res = await asToken('POST', '/api/v1/leads/merge', { keepId: L_KEEP, dropIds: [L_DROP] });
      assert.equal(res.status, 403);
      assert(leadRow(L_DROP), 'drop lead survives token merge');
      res = await post(member.jar, '/api/v1/leads/merge', { keepId: L_KEEP, dropIds: [L_DROP] });
      assert.equal(res.status, 403);
      assert(leadRow(L_DROP), 'drop lead survives member merge');
      res = await post(owner.jar, '/api/v1/leads/merge', { keepId: L_KEEP, dropIds: [L_DROP] });
      assert.equal(res.status, 200);
      assert(leadRow(L_KEEP), 'keep lead remains');
      assert(!leadRow(L_DROP), 'drop lead merged away');
    });
    await checkAsync('census gates over HTTP: token → 403 on campaigns/templates/suppression/design deletes', async () => {
      for (const p of [
        `/api/v1/campaigns/${CAMPAIGN_ID}`,
        `/api/v1/templates/${TEMPLATE_ID}`,
        `/api/v1/suppression/${SUPPRESSION_ID}`,
        `/api/v1/design/${JOB_ID}`,
      ]) {
        const res = await asToken('DELETE', p);
        assert.equal(res.status, 403, `${p} → ${res.status}`);
      }
      const res = await del(owner.jar, `/api/v1/campaigns/${CAMPAIGN_ID}`);
      assert.equal(res.status, 200, 'owner can still delete a campaign');
    });
    await checkAsync('MCP path unaffected: facade deletes run without any HTTP role context', async () => {
      const r = await domain.leadsDelete(WS, L_SCRATCH);
      assert(r && typeof r === 'object', 'facade leadsDelete returns its outcome');
      assert(!leadRow(L_SCRATCH), 'scratch lead deleted via facade');
      domain.designDelete(WS, JOB2_ID);
      const left = openWorkspaceDb(WS).prepare('SELECT id FROM design_jobs WHERE id = ?').get(JOB2_ID);
      assert(!left, 'design job deleted via facade');
    });

    // ---------------- Fix 1 over the wire ----------------
    const claimToken = outreach.signInterestToken({ workspaceId: WS, leadId: L_CLAIM, action: 'c' });
    const claimPost = (body) =>
      fetch(`${BASE}/api/v1/outreach/public/claim/${claimToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    const claimEvents = (type) =>
      Number(
        openWorkspaceDb(WS)
          .prepare('SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = ?')
          .get(L_CLAIM, type).c
      );
    await checkAsync('claim HTTP: garbage action → 400 VALIDATION, no state change, no dispatch', async () => {
      const res = await claimPost({ action: 'QA-REVIEW-invalid' });
      const body = await json(res);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, 'VALIDATION');
      assert.equal(leadRow(L_CLAIM).status, 'new');
      assert.equal(claimEvents('email.followup_dispatched'), 0);
    });
    await checkAsync('claim HTTP: missing action → 400 VALIDATION', async () => {
      const res = await claimPost({});
      assert.equal(res.status, 400);
      assert.equal(leadRow(L_CLAIM).status, 'new');
    });
    await checkAsync('claim HTTP: interested → engaged + dispatch marker; repeat → already', async () => {
      let res = await claimPost({ action: 'interested' });
      let body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.action, 'interested');
      assert.equal(body.data.already, false);
      assert.equal(leadRow(L_CLAIM).status, 'engaged');
      assert.equal(claimEvents('email.followup_dispatched'), 1, 'follow-up claimed exactly once');
      res = await claimPost({ action: 'interested' });
      body = await json(res);
      assert.equal(body.data.already, true);
      assert.equal(claimEvents('email.followup_dispatched'), 1, 'no second dispatch');
    });

    // ---------------- Fix 3: register/MFA parity ----------------
    await checkAsync('register → MFA challenge (enroll), NO session until enrollment completes', async () => {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/register', {
        email: NEWBIE_EMAIL,
        password: PW,
        name: 'Batch53 Newbie',
        workspaceName: 'Newbie Workspace',
        acceptTerms: true,
      });
      let body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.mfaRequired, true, 'register answers with the challenge, not a session');
      assert.equal(body.data.mfaStage, 'enroll');
      assert(!body.data.user, 'no auth payload before the second factor');
      res = await get(jar, '/api/v1/auth/me');
      assert.equal(res.status, 401, 'no session exists before enrollment');
      res = await post(jar, '/api/v1/auth/mfa/enroll/start', {});
      body = await json(res);
      const secret = body.data.secret;
      assert(secret, 'enroll start works from the register challenge');
      res = await post(jar, '/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(secret) });
      body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.user.email, NEWBIE_EMAIL);
      assert(
        body.data.workspaces && body.data.workspaces[0] && body.data.workspaces[0].role === 'owner',
        'the registrant owns the workspace they created'
      );
      res = await get(jar, '/api/v1/auth/me');
      assert.equal(res.status, 200, 'session live after enrollment');
    });
    await checkAsync('register validation unchanged: duplicate email + missing terms still refused', async () => {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/register', {
        email: NEWBIE_EMAIL,
        password: PW,
        acceptTerms: true,
      });
      let body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(body.code, 'REGISTRATION_FAILED');
      res = await post(jar, '/api/v1/auth/register', { email: 'terms53@example.invalid', password: PW });
      assert.equal(res.status, 400, 'acceptTerms still required');
    });
    await checkAsync('login flow untouched: enrolled owner now gets the verify stage and completes it', async () => {
      const jar = makeJar();
      let res = await post(jar, '/api/v1/auth/login', { email: OWNER_EMAIL, password: PW });
      let body = await json(res);
      assert.equal(body.data.mfaRequired, true);
      assert.equal(body.data.mfaStage, 'verify');
      res = await post(jar, '/api/v1/auth/mfa/verify', { code: totp.totp(owner.secret) });
      body = await json(res);
      assert.equal(res.status, 200);
      assert(body.data.user && body.data.user.email === OWNER_EMAIL);
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

/* ===================================================================== */

(async () => {
  let failure = null;
  try {
    partA();
    if (!NEGATIVE) {
      partB();
      await partC();
    }
  } catch (e) {
    failure = e;
  } finally {
    fs.rmSync(path.join(root, 'src/.b53-negative-outreach.js'), { force: true });
  }
  if (NEGATIVE) {
    if (failure) {
      console.log(
        JSON.stringify({ batch53NegativeProof: 'FAILED as expected against the pre-fix shim', error: failure.message })
      );
      process.exit(1);
    }
    console.error('B53_NEGATIVE: the suite PASSED against the pre-fix shim — the negative proof is broken.');
    process.exit(1);
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
  console.log(JSON.stringify({ batch53Checks: results.length, passed: true, checks: results }));
})();
