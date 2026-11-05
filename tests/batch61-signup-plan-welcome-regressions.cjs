'use strict';
/**
 * Batch 61 — signup plan step + welcome email.
 *
 *   PLAN STEP — POST /auth/register accepts an optional `plan` from the
 *   Register tab's plan step (GET /auth/plans serves billing.
 *   catalogForApi verbatim, so Batch 57 contents + settings pricing are
 *   exactly what a new owner picks from). The choice persists in
 *   signup_plan_choices: Free (or absent) lands Free with core access
 *   and NO checkout; a paid plan creates its Stripe Checkout session
 *   through the existing billing.createCheckoutSession — proven below
 *   against the REAL billing module with only the Stripe transport
 *   stubbed, asserting the session is built from the settings price id.
 *   Checkout NEVER gates workspace access: an unconfigured/unreachable
 *   Stripe degrades the choice to checkout_unavailable and registration
 *   still succeeds. An unknown plan is refused (400 INVALID_PLAN)
 *   BEFORE any account is created.
 *
 *   WELCOME EMAIL — exactly once per new account, riding an atomic
 *   claim on the signup row (welcome_status pending → claimed), the
 *   Batch 36 pattern. A mail failure records status 'failed' + an audit
 *   row and never fails registration. Admin-created users never pass
 *   through the signup module (their invite flow is separate).
 *
 *   REGISTRATION CLOSED — with registration.open = '0' the register
 *   route still refuses with REGISTRATION_DISABLED (the live posture).
 *
 *   NEGATIVE PROOF: B61_NEGATIVE=1 injects an always-winning claim —
 *   the welcome email then sends TWICE, proving the claim is the only
 *   thing standing between a replay and a duplicate email.
 *
 * Harness: deps-injected unit checks + the real billing module on an
 * in-process platform DB, then HTTP checks against the real server
 * booted on the same temp DB (batch53 pattern). DB_DRIVER=sqlite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b61-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch61', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const NEGATIVE = process.env.B61_NEGATIVE === '1';
const PORT = 31461;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch61', 'fixture', 'password'].join('-');

const results = [];
function check(name, fn) {
  if (typeof fn === 'function') fn();
  else assert(fn, name);
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

/* Stripe transport stub — installed BEFORE billing loads anywhere in
 * this process, because billing.js destructures getStripe at load. */
const stripeCalls = { sessions: [], customersCreated: [] };
const stripeStub = {
  customers: {
    search: async () => ({ data: [] }),
    list: async () => ({ data: [] }),
    create: async (params) => {
      stripeCalls.customersCreated.push(params);
      return { id: 'cus_b61' };
    },
  },
  checkout: {
    sessions: {
      create: async (params) => {
        stripeCalls.sessions.push(params);
        return { id: 'cs_b61', url: 'https://checkout.stripe.test/cs_b61' };
      },
    },
  },
};
require(path.join(root, 'server/stripeClient.js')).getStripe = async () => stripeStub;

const platformDb = require(path.join(root, 'server/db.js'));
const q = platformDb.query;

async function setSetting(key, value) {
  // Batch 112: dialect-aware (was raw SQLite upsert through the facade).
  await require('./lib/platformTestDb.cjs').setPlatformSetting(platformDb, key, value);
}

/* ==================================================================== */
/* Part A — deps-injected unit checks                                    */
/* ==================================================================== */

async function partA() {
  await platformDb.migrate();
  // Batch 143: registration now defaults CLOSED when unset (the old
  // ON default was the review's registration bug). This suite tests
  // signup flows, so it opens registration explicitly — the closed
  // case is exercised in Part C by setting it back to '0'.
  await setSetting('registration.open', '1');
  const signup = require(path.join(root, 'server/signup.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));

  const catalogFixture = [
    { id: 'free', name: 'Free', checkout: false, priceConfigured: true },
    { id: 'standard', name: 'Standard', checkout: true, priceConfigured: true },
    { id: 'pro', name: 'Pro', checkout: true, priceConfigured: true },
    { id: 'premium', name: 'Premium', checkout: true, priceConfigured: false },
  ];
  const mkDeps = (over = {}) => ({
    query: q,
    catalog: async () => catalogFixture,
    createCheckout: async () => ({ sessionId: 'cs_stub', url: 'https://checkout.stub/cs' }),
    sendMail: async () => ({ sent: true }),
    getSetting: async (k, fb) => fb || '',
    audit: async () => {},
    ...over,
  });

  const u1 = await workspace.createUserWithWorkspace({
    email: 'a-free@example.invalid', password: PW, name: 'Free Fran', workspaceName: 'Fran Co',
  });
  await acheck('A1: free choice persists as Free, no checkout attempted', async () => {
    let checkoutCalls = 0;
    const out = await signup.applyPlanChoice(
      { userId: u1.userId, workspaceId: u1.workspaceId, planId: 'free' },
      mkDeps({ createCheckout: async () => { checkoutCalls++; return {}; } })
    );
    assert.equal(out.plan, 'free');
    assert.equal(out.status, 'free');
    assert.equal(out.checkoutUrl, null);
    assert.equal(checkoutCalls, 0);
    const row = await signup.getChoice(u1.userId, { query: q });
    assert(row && row.plan_id === 'free' && row.status === 'free', 'row persisted');
    assert.equal(Number(row.workspace_id), Number(u1.workspaceId));
  });

  const u2 = await workspace.createUserWithWorkspace({
    email: 'a-pro@example.invalid', password: PW, name: 'Pro Pete', workspaceName: 'Pete Co',
  });
  await acheck('A2: paid choice routes to checkout creation with the chosen plan', async () => {
    const seen = [];
    const out = await signup.applyPlanChoice(
      { userId: u2.userId, workspaceId: u2.workspaceId, planId: 'pro', catalogEntry: catalogFixture[2] },
      mkDeps({ createCheckout: async (uid, plan) => { seen.push([uid, plan]); return { sessionId: 'cs_pro', url: 'https://checkout.stub/pro' }; } })
    );
    assert.deepEqual(seen, [[Number(u2.userId), 'pro']]);
    assert.equal(out.status, 'checkout_pending');
    assert.equal(out.checkoutUrl, 'https://checkout.stub/pro');
    const row = await signup.getChoice(u2.userId, { query: q });
    assert.equal(row.plan_id, 'pro');
    assert.equal(row.status, 'checkout_pending');
    assert.equal(row.checkout_session_id, 'cs_pro');
    assert.equal(row.checkout_url, 'https://checkout.stub/pro');
  });

  const u3 = await workspace.createUserWithWorkspace({
    email: 'a-prem@example.invalid', password: PW, name: 'Prem Pam', workspaceName: 'Pam Co',
  });
  await acheck('A3: paid plan without a configured price → checkout_unavailable, no checkout call, no throw', async () => {
    let calls = 0;
    const out = await signup.applyPlanChoice(
      { userId: u3.userId, workspaceId: u3.workspaceId, planId: 'premium', catalogEntry: catalogFixture[3] },
      mkDeps({ createCheckout: async () => { calls++; return {}; } })
    );
    assert.equal(calls, 0);
    assert.equal(out.status, 'checkout_unavailable');
    assert.equal(out.checkoutError, 'PRICE_NOT_CONFIGURED');
    const row = await signup.getChoice(u3.userId, { query: q });
    assert.equal(row.status, 'checkout_unavailable');
  });

  const u4 = await workspace.createUserWithWorkspace({
    email: 'a-down@example.invalid', password: PW, name: 'Down Dan', workspaceName: 'Dan Co',
  });
  await acheck('A4: Stripe failure degrades to checkout_unavailable — registration path never throws', async () => {
    const out = await signup.applyPlanChoice(
      { userId: u4.userId, workspaceId: u4.workspaceId, planId: 'standard', catalogEntry: catalogFixture[1] },
      mkDeps({
        createCheckout: async () => {
          throw Object.assign(new Error('Stripe is not configured'), { code: 'STRIPE_NOT_CONFIGURED' });
        },
      })
    );
    assert.equal(out.status, 'checkout_unavailable');
    assert.equal(out.checkoutError, 'STRIPE_NOT_CONFIGURED');
  });

  /* Welcome email — exactly once, failure-safe, content-bearing. */
  const u5 = await workspace.createUserWithWorkspace({
    email: 'a-welcome@example.invalid', password: PW, name: 'Wel Come', workspaceName: 'Welcome Co',
  });
  await signup.applyPlanChoice({ userId: u5.userId, workspaceId: u5.workspaceId, planId: 'free' }, mkDeps());
  const sent = [];
  const audits = [];
  const welcomeDeps = mkDeps({
    sendMail: async (mail) => { sent.push(mail); return { sent: true }; },
    getSetting: async (k, fb) => (k === 'support.email' ? 'help@bitpype.test' : fb || ''),
    audit: async (uid, action, detail) => audits.push([uid, action, detail]),
  });
  await acheck('A5: welcome email sends once with plan, workspace, sign-in CTA and support line', async () => {
    const r = await signup.sendWelcomeEmail(
      { userId: u5.userId, workspaceId: u5.workspaceId, email: 'a-welcome@example.invalid', name: 'Wel Come', workspaceName: 'Welcome Co', planId: 'free' },
      welcomeDeps
    );
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.to, 'a-welcome@example.invalid');
    assert.match(mail.subject, /Welcome to BitPype/);
    const body = mail.paragraphs.join('\n');
    assert.match(body, /Welcome Co/);
    assert.match(body, /Free plan/);
    assert.match(body, /help@bitpype\.test/);
    assert(mail.cta && mail.cta.url === 'https://bitpype.test', 'sign-in CTA from the public URL resolver');
    const row = await signup.getChoice(u5.userId, { query: q });
    assert.equal(row.welcome_status, 'sent');
    assert(row.welcome_sent_at, 'sent stamp recorded');
    assert(audits.some((a) => a[1] === 'signup.welcome_email'), 'audit row written');
  });

  await acheck(
    NEGATIVE
      ? 'A6 (NEGATIVE PROOF): always-winning claim → the welcome email sends TWICE'
      : 'A6: replayed welcome attempts lose the claim — still exactly one email',
    async () => {
      const deps = NEGATIVE
        ? { ...welcomeDeps, claimWelcome: async () => true }
        : welcomeDeps;
      const r2 = await signup.sendWelcomeEmail(
        { userId: u5.userId, workspaceId: u5.workspaceId, email: 'a-welcome@example.invalid', name: 'Wel Come', planId: 'free' },
        deps
      );
      const r3 = await signup.afterSignup(
        { userId: u5.userId, workspaceId: u5.workspaceId, email: 'a-welcome@example.invalid', name: 'Wel Come', planId: 'free' },
        deps
      );
      if (NEGATIVE) {
        assert(sent.length >= 3, `expected duplicate sends without the claim, got ${sent.length}`);
        assert.equal(r2.sent, true);
        assert.equal(r3.welcome.sent, true);
      } else {
        assert.equal(sent.length, 1, 'exactly one welcome email across replays');
        assert.equal(r2.sent, false);
        assert.equal(r2.reason, 'already_claimed');
        assert.equal(r3.welcome.sent, false);
      }
    }
  );

  const u6 = await workspace.createUserWithWorkspace({
    email: 'a-mailfail@example.invalid', password: PW, name: 'Mail Fail', workspaceName: 'Fail Co',
  });
  await acheck('A7: mailer failure → recorded failed + audit, signup flow still returns its plan choice', async () => {
    const failAudits = [];
    const out = await signup.afterSignup(
      { userId: u6.userId, workspaceId: u6.workspaceId, email: 'a-mailfail@example.invalid', name: 'Mail Fail', planId: 'free' },
      mkDeps({
        sendMail: async () => { throw new Error('Platform mail is not configured'); },
        audit: async (uid, action, detail) => failAudits.push([uid, action, detail]),
      })
    );
    assert.equal(out.planChoice.status, 'free');
    assert.equal(out.welcome.sent, false);
    assert.equal(out.welcome.reason, 'send_failed');
    const row = await signup.getChoice(u6.userId, { query: q });
    assert.equal(row.welcome_status, 'failed');
    assert(failAudits.some((a) => a[1] === 'signup.welcome_email_failed'), 'failure audit row written');
  });

  /* The REAL billing module builds the session from the settings price
   * id — only the Stripe transport (getStripe) is stubbed, above. */
  await setSetting('stripe.price_id_standard', 'price_std_settings');
  await setSetting('stripe.price_id_pro', 'price_pro_settings');
  await setSetting('stripe.price_id_premium', 'price_prem_settings');
  const u7 = await workspace.createUserWithWorkspace({
    email: 'a-realbill@example.invalid', password: PW, name: 'Real Bill', workspaceName: 'Bill Co',
  });
  await acheck('A8: real billing.createCheckoutSession receives the settings price id for the chosen plan', async () => {
    const signupReal = require(path.join(root, 'server/signup.js'));
    const out = await signupReal.afterSignup(
      { userId: u7.userId, workspaceId: u7.workspaceId, email: 'a-realbill@example.invalid', name: 'Real Bill', planId: 'pro' },
      { query: q, sendMail: async () => ({ sent: true }), audit: async () => {}, getSetting: async (k, fb) => fb || '' }
    );
    assert.equal(out.planChoice.status, 'checkout_pending');
    assert.equal(out.planChoice.checkoutUrl, 'https://checkout.stripe.test/cs_b61');
    const params = stripeCalls.sessions[stripeCalls.sessions.length - 1];
    assert(params, 'a Stripe checkout session was created');
    assert.equal(params.line_items[0].price, 'price_pro_settings', 'price id comes from platform settings');
    assert.equal(params.metadata.plan, 'pro');
    assert.equal(params.metadata.user_id, String(u7.userId));
    assert.equal(params.mode, 'subscription');
  });
}

/* ==================================================================== */
/* Part B — structural pins                                              */
/* ==================================================================== */

function partB() {
  const auth = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
  const signupSrc = fs.readFileSync(path.join(root, 'server/signup.js'), 'utf8');
  const dbSrc = fs.readFileSync(path.join(root, 'server/db.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');

  check('B1: /auth/plans serves billing.catalogForApi', () => {
    assert(auth.includes("router.get('/plans'"));
    assert(auth.includes('billing.catalogForApi()'));
  });
  check('B2: register validates the plan BEFORE creating the account', () => {
    const reg = auth.slice(auth.indexOf("router.post('/register'"));
    const validateAt = reg.indexOf('INVALID_PLAN');
    const createAt = reg.indexOf('createUserWithWorkspace');
    assert(validateAt > -1 && createAt > validateAt, 'INVALID_PLAN precedes creation');
    assert(reg.includes('planChoice'), 'register returns the plan choice');
  });
  check('B3: welcome claim is the pending→claimed atomic UPDATE', () => {
    assert(signupSrc.includes("welcome_status = 'claimed'"));
    assert(signupSrc.includes("welcome_status = 'pending'"));
  });
  check('B4: signup table exists in BOTH migrate dialects', () => {
    assert.equal(dbSrc.split('signup_plan_choices').length - 1 >= 2, true);
  });
  check('B5: client plan step + checkout redirect plumbing present', () => {
    assert(api.includes("authPlans: () => get('/auth/plans')"));
    assert(app.includes('reg-plan-options'));
    assert(app.includes('pendingSignupCheckoutUrl'));
    assert(app.includes('res.data.planChoice.checkoutUrl'));
  });
  check('B6: admin user creation does NOT route through the signup module', () => {
    const admin = fs.readFileSync(path.join(root, 'server/admin.js'), 'utf8');
    assert(!admin.includes("require('./signup')"), 'admin.js must not send welcome mail');
    const adminRoutes = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
    assert(!adminRoutes.includes("require('../signup')"), 'admin routes must not send welcome mail');
  });
}

/* ==================================================================== */
/* Part C — HTTP against the booted server                               */
/* ==================================================================== */

function makeJar() {
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
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function partC() {
  const signup = require(path.join(root, 'server/signup.js'));
  const billing = require(path.join(root, 'server/billing.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));

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

    const jar = makeJar();
    const post = (p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
    const get = (p) => jar.fetch(BASE + p);

    await acheck('C1: GET /auth/plans matches billing.catalogForApi byte-for-byte', async () => {
      const res = await get('/api/v1/auth/plans');
      const body = await json(res);
      assert.equal(res.status, 200);
      const expected = await billing.catalogForApi();
      assert.equal(JSON.stringify(body.data.plans), JSON.stringify(expected));
    });

    let httpFreeUserId = null;
    await acheck('C2: register with plan=free → challenge + persisted Free choice; welcome attempted once (mail unconfigured → failed, registration fine)', async () => {
      const res = await post('/api/v1/auth/register', {
        email: 'c-free@example.invalid', password: PW, name: 'Http Free', workspaceName: 'Http Free Co',
        acceptTerms: true, plan: 'free',
      });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.mfaRequired, true);
      assert(body.data.planChoice && body.data.planChoice.plan === 'free' && body.data.planChoice.status === 'free');
      const user = await workspace.findUserByEmail('c-free@example.invalid');
      httpFreeUserId = user.id;
      const row = await signup.getChoice(user.id, { query: q });
      assert(row && row.plan_id === 'free', 'choice persisted');
      // The test platform has no SMTP configured: the send fails, is
      // recorded, and the registration above still returned 200.
      assert.equal(row.welcome_status, 'failed');
    });

    await acheck('C3: register replay (same email) → refused; the welcome claim is untouched', async () => {
      const res = await post('/api/v1/auth/register', {
        email: 'c-free@example.invalid', password: PW, name: 'Http Free', acceptTerms: true, plan: 'free',
      });
      assert.equal(res.status, 400);
      const rows = await q('SELECT COUNT(*) AS c FROM signup_plan_choices WHERE user_id = :uid', { uid: httpFreeUserId });
      assert.equal(Number(rows[0].c), 1, 'still exactly one signup row');
    });

    await acheck('C4: unknown plan → 400 INVALID_PLAN and NO account created', async () => {
      const res = await post('/api/v1/auth/register', {
        email: 'c-bogus@example.invalid', password: PW, name: 'Bogus', acceptTerms: true, plan: 'platinum',
      });
      const body = await json(res);
      assert.equal(res.status, 400);
      assert.equal(body.code, 'INVALID_PLAN');
      assert.equal(await workspace.findUserByEmail('c-bogus@example.invalid'), null);
    });

    await acheck('C5: register with no plan field → Free default', async () => {
      const res = await post('/api/v1/auth/register', {
        email: 'c-noplan@example.invalid', password: PW, name: 'No Plan', acceptTerms: true,
      });
      const body = await json(res);
      assert.equal(res.status, 200);
      assert.equal(body.data.planChoice.plan, 'free');
    });

    await acheck('C6: registration CLOSED still refuses with REGISTRATION_DISABLED', async () => {
      await setSetting('registration.open', '0');
      let status = 0;
      let body = null;
      for (let n = 0; n < 50 && status !== 403; n++) {
        const res = await post('/api/v1/auth/register', {
          email: 'c-closed@example.invalid', password: PW, name: 'Closed', acceptTerms: true,
        });
        status = res.status;
        body = await json(res);
        if (status !== 403) await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(status, 403);
      assert.equal(body.error, 'REGISTRATION_DISABLED');
      assert.equal(await workspace.findUserByEmail('c-closed@example.invalid'), null);
      await setSetting('registration.open', '1');
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

(async () => {
  try {
    await partA();
    partB();
    await partC();
    console.log(JSON.stringify({ file: 'batch61-signup-plan-welcome-regressions', checks: results.length, passed: true }));
    for (const r of results) console.log('  ok -', r);
  } catch (e) {
    console.error('BATCH61 FAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
