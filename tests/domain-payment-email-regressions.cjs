'use strict';
/**
 * Batch 36 — claim/domain flow fixes Ely approved after walking the live
 * test flow (2026-10-27):
 *
 *   FIX 1 — at paid time the client previously got NO email at all (only
 *     the admin was notified; the client's first email was the later
 *     go-live one). onDomainCheckoutPaid now ALSO sends the client a
 *     payment-received email in the same once-only markPaid transition:
 *       A — paid → exactly one client email (plan + price + domain +
 *           what-happens-next copy) next to the one admin email; a
 *           duplicate webhook call resends NEITHER.
 *       B — client sendMail throws → transaction still lands paid, the
 *           failure is a client_payment_email step (ok=false), the admin
 *           email still went out.
 *       C — lead without an email → no send, no throw, skip noted as a
 *           client_payment_email step; transaction still paid.
 *       D — composer dry-run: price text comes from the platform plan
 *           label the picker renders, else falls back to amount paid.
 *   FIX 2 — public/domain-picker.html sanitizes the domain search query
 *     (NFKD, strip combining marks, [a-zA-Z0-9\s-] only) for BOTH the
 *     business-name prefill and doSearch(), so raw names like
 *     "Berks Roll-Off Co. — Berks County dumpster rental (rank-and-rent)"
 *     no longer trip the registrar's "Internationalized Domain Names
 *     not supported".
 *   FIX 3 — public/js/claim-preview.js persists the localStorage done
 *     flag ONLY on a real Yes/No answer (persistDone() called solely
 *     from decide()); server-meta suppression now sets the in-memory
 *     visitAnswered guard only, so a lead reset makes the popup show
 *     again on the next visit in the same browser. Snippet bumped to
 *     claim-preview.js?v=8.
 *
 * Negative proofs: removing the client-email block from
 * onDomainCheckoutPaid fails A/B/C; restoring the raw prefill fails the
 * Fix 2 wiring checks; calling persistDone() from the meta-suppression
 * branch fails the Fix 3 structure checks.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
process.env.APP_URL = 'https://bitpype.test';

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, status TEXT);
  CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, preview_url TEXT, custom_domain TEXT, status TEXT);
`);

function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module,
    exports: module.exports,
    require: (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    },
    process: { env: {} },
    console,
    Buffer,
    URL,
    Date,
    setTimeout,
    clearTimeout,
  }, { filename: file });
  return module.exports;
}

const cfStub = {
  normalizeDomain: (d) => {
    const s = String(d || '').trim().toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
  },
  ensureTables: () => {},
};
const outreachStub = {
  verifyInterestToken: (token) => {
    const [w, l, a] = String(token || '').split('.');
    const action = a === 'd' ? 'domain' : a === 'c' ? 'claim' : a === 'u' ? 'uninterested' : 'interested';
    if (!w || !l || !a) throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
    return { workspaceId: Number(w), leadId: Number(l), action };
  },
  getSetting: (d, key, fb) => (key === 'smtp.from_email' ? 'team@bitpype.test' : fb || ''),
};
// The picker page renders the platform-configured amount labels; only the
// Standard label is configured in this fixture (Pro exercises the fallback).
const platformStub = {
  getPlatformSetting: async (key, fb) => (key === 'billing.amount_label_standard' ? 'Standard · $99/mo' : fb || ''),
};

const df = load('server/domainFlow.js', {
  '../src/cfDomains': cfStub,
  '../src/outreach': outreachStub,
  '../src/claimKit': { buildDomainPickerUrl: (w, l) => `https://bitpype.test/domain-picker.html?t=${w}.${l}.d` },
  './plans': require(path.join(root, 'server/plans.js')),
  './appUrls': { staffUrl: (route, params) => `https://bitpype.test/app#/${route}?txn=${params.txn}` },
});
df.ensureTables(db);

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function acheck(name, fn) {
  await fn();
  results.push(name);
}

function makeLead(id, name, email) {
  db.prepare('INSERT INTO leads (id, business_name, email, phone, status) VALUES (?, ?, ?, ?, ?)').run(
    id, name, email, '5550001111', 'engaged'
  );
  db.prepare('INSERT INTO websites (lead_id, name, preview_url) VALUES (?, ?, ?)').run(id, name + ' Site', '');
  return db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(id).id;
}
function stepsOf(txnId) {
  return JSON.parse(df.getTransaction(db, txnId).steps_json || '[]');
}
function sessionFor(txnId, amountTotal) {
  return {
    id: 'cs_test_' + txnId,
    metadata: { domain_transaction_id: String(txnId), domain_workspace_id: '1' },
    subscription: 'sub_' + txnId,
    customer: 'cus_' + txnId,
    amount_total: amountTotal,
  };
}

async function main() {
  /* ---------- FIX 1 · A: paid → one client email, exactly once ---------- */
  const siteA = makeLead(601, 'Fixture Bakery', 'owner@fixture.test');
  const txnA = df.createTransaction(db, {
    leadId: 601, websiteId: siteA, domain: 'fixturebakery.com',
    registrarPriceCents: 1299, registrarCurrency: 'USD', planId: 'standard',
  });
  const sentA = [];
  const sendA = async (mail) => { sentA.push(mail); return { sent: true }; };
  let resA;
  await acheck('A: paid fires the client payment email alongside the admin email', async () => {
    resA = await df.onDomainCheckoutPaid(sessionFor(txnA.id, 9900), {
      openDb: () => db, sendMail: sendA, platform: platformStub,
    });
    assert.equal(resA.ok, true);
    assert.equal(df.getTransaction(db, txnA.id).status, 'paid');
    assert.equal(sentA.length, 2, 'admin + client, nothing else');
    const admin = sentA.filter((m) => m.to === 'team@bitpype.test');
    const client = sentA.filter((m) => m.to === 'owner@fixture.test');
    assert.equal(admin.length, 1, 'exactly one admin email');
    assert.equal(client.length, 1, 'exactly one client email');
    assert.equal(resA.clientEmail.to, 'owner@fixture.test');
    assert.equal(client[0].subject, 'Payment received for fixturebakery.com');
    assert.equal(resA.clientEmail.subject, 'Payment received for fixturebakery.com');
  });
  check('A: client email carries plan, price, domain and the what-happens-next copy', () => {
    const client = sentA.find((m) => m.to === 'owner@fixture.test');
    const body = JSON.stringify(client);
    assert.ok(body.includes('Standard'), 'plan name in the email');
    assert.ok(body.includes('$99/mo'), 'monthly price from the picker plan label');
    assert.ok(body.includes('fixturebakery.com'), 'chosen domain in the email');
    assert.ok(
      body.includes("We're registering fixturebakery.com and putting your site live."),
      'registration next-step copy present'
    );
    assert.ok(body.includes("There's nothing else you need to do."), 'nothing-to-do copy present');
    const steps = stepsOf(txnA.id);
    assert.ok(steps.some((s) => s.step === 'client_payment_email' && s.ok === true), 'success step recorded');
    assert.ok(steps.some((s) => s.step === 'admin_email' && s.ok === true), 'admin step still recorded');
  });
  await acheck('A: duplicate paid call resends neither email', async () => {
    const dup = await df.onDomainCheckoutPaid(sessionFor(txnA.id, 9900), {
      openDb: () => db, sendMail: sendA, platform: platformStub,
    });
    assert.equal(dup.duplicate, true);
    assert.equal(sentA.length, 2, 'no resend on duplicate webhook');
    assert.equal(sentA.filter((m) => m.to === 'owner@fixture.test').length, 1, 'client email still exactly once');
  });

  /* ---------- FIX 1 · B: client send failure never unwinds paid ---------- */
  const siteB = makeLead(602, 'Fixture Pro Shop', 'boss@fixture.test');
  const txnB = df.createTransaction(db, {
    leadId: 602, websiteId: siteB, domain: 'fixturepro.com',
    registrarPriceCents: 1100, registrarCurrency: 'USD', planId: 'pro',
  });
  const sentB = [];
  const sendB = async (mail) => {
    if (mail.to === 'boss@fixture.test') throw new Error('SMTP boom');
    sentB.push(mail);
    return { sent: true };
  };
  await acheck('B: client sendMail throwing still lands paid with a failed step recorded', async () => {
    const res = await df.onDomainCheckoutPaid(sessionFor(txnB.id, 16900), {
      openDb: () => db, sendMail: sendB, platform: platformStub,
    });
    assert.equal(res.ok, true);
    assert.equal(df.getTransaction(db, txnB.id).status, 'paid', 'paid transition survives the email failure');
    assert.equal(res.clientEmail, null);
    assert.equal(res.clientEmailError, 'SMTP boom');
    assert.equal(sentB.length, 1, 'admin email still delivered');
    assert.equal(sentB[0].to, 'team@bitpype.test');
    const steps = stepsOf(txnB.id);
    const failStep = steps.find((s) => s.step === 'client_payment_email');
    assert.ok(failStep && failStep.ok === false, 'failed client_payment_email step recorded');
    assert.ok(failStep.detail.includes('SMTP boom'), 'failure detail carries the error');
  });

  /* ---------- FIX 1 · C: no recipient → quiet skip, still paid ---------- */
  const siteC = makeLead(603, 'Fixture No Email', '');
  const txnC = df.createTransaction(db, {
    leadId: 603, websiteId: siteC, domain: 'fixturenoemail.com',
    registrarPriceCents: 999, registrarCurrency: 'USD', planId: 'standard',
  });
  const sentC = [];
  await acheck('C: lead without email → no client send, no throw, skip noted, still paid', async () => {
    const res = await df.onDomainCheckoutPaid(sessionFor(txnC.id, 9900), {
      openDb: () => db, sendMail: async (mail) => { sentC.push(mail); return { sent: true }; }, platform: platformStub,
    });
    assert.equal(res.ok, true);
    assert.equal(df.getTransaction(db, txnC.id).status, 'paid');
    assert.equal(res.clientEmail, null);
    assert.ok(/No client email/.test(res.clientEmailError || ''), 'skip reason surfaced');
    assert.equal(sentC.length, 1, 'only the admin email went out');
    const skipStep = stepsOf(txnC.id).find((s) => s.step === 'client_payment_email');
    assert.ok(skipStep && skipStep.ok === false && /No client email/.test(skipStep.detail), 'skip noted as a step');
  });

  /* ---------- FIX 1 · D: composer price sources ---------- */
  await acheck('D: composer dry-run — label price wins; paid amount is the fallback', async () => {
    const a = await df.composeClientPaymentEmail(db, 1, txnA.id, { platform: platformStub });
    assert.equal(a.to, 'owner@fixture.test');
    assert.equal(a.subject, 'Payment received for fixturebakery.com');
    assert.ok(a.text.includes('Standard plan ($99/mo)'), 'label-derived price in copy');
    const b = await df.composeClientPaymentEmail(db, 1, txnB.id, { platform: platformStub });
    assert.ok(b.text.includes('Pro plan ($169.00/mo)'), 'amount-paid fallback when no label is configured');
  });

  /* ---------- FIX 2: picker sanitization ---------- */
  const pickerSrc = fs.readFileSync(path.join(root, 'public/domain-picker.html'), 'utf8');
  check('FIX2: sanitizer exists and is wired into BOTH the prefill and doSearch', () => {
    assert.ok(pickerSrc.includes('function sanitizeDomainQuery(raw)'), 'sanitizer defined');
    assert.ok(
      pickerSrc.includes("qInput.value = sanitizeDomainQuery(d.businessName || '');"),
      'prefill is sanitized before it is shown or searched'
    );
    assert.ok(pickerSrc.includes('const q = sanitizeDomainQuery(qInput.value);'), 'doSearch sanitizes its query');
    assert.ok(!pickerSrc.includes("qInput.value = d.businessName || '';"), 'raw prefill gone');
  });
  check('FIX2: sanitizer behavior — Ely’s Berks name and diacritics come out registrar-safe', () => {
    const m = /function sanitizeDomainQuery\(raw\) \{[\s\S]*?\n      \}/.exec(pickerSrc);
    assert.ok(m, 'sanitizer extractable');
    const sanitize = new Function('return ' + m[0])();
    const berks = sanitize('Berks Roll-Off Co. — Berks County dumpster rental (rank-and-rent)');
    assert.equal(berks, 'Berks Roll-Off Co Berks County dumpster rental rank-and-rent');
    assert.ok(/^[-a-zA-Z0-9 ]*$/.test(berks), 'output charset is registrar-safe');
    assert.equal(sanitize('Café Müller & Söhne!'), 'Cafe Muller Sohne', 'diacritics fold to ASCII');
    assert.equal(sanitize('  A--1   Plumb—ing… Co. '), 'A-1 Plumbing Co', 'hyphens/spaces collapse, junk stripped');
  });

  /* ---------- FIX 3: claim-preview persistence discipline ---------- */
  const popupSrc = fs.readFileSync(path.join(root, 'public/js/claim-preview.js'), 'utf8');
  const kitSrc = fs.readFileSync(path.join(root, 'src/claimKit.js'), 'utf8');
  check('FIX3: the done flag is written in exactly one place — persistDone()', () => {
    const writes = popupSrc.match(/localStorage\.setItem\(storageKey/g) || [];
    assert.equal(writes.length, 1, 'single localStorage write of the done key');
    const defAt = popupSrc.indexOf('function persistDone()');
    assert.ok(defAt >= 0, 'persistDone defined');
    const writeAt = popupSrc.indexOf('localStorage.setItem(storageKey');
    const nextFnAt = popupSrc.indexOf('\n  function ', defAt + 10);
    assert.ok(writeAt > defAt && (nextFnAt === -1 || writeAt < nextFnAt), 'the write lives inside persistDone');
    assert.ok(!popupSrc.includes('markDone'), 'old markDone name gone');
  });
  check('FIX3: persistDone() is called ONLY from decide() — the real Yes/No answers', () => {
    const decideAt = popupSrc.indexOf('async function decide(');
    const decideEnd = popupSrc.indexOf('/** Pull colors', decideAt);
    assert.ok(decideAt >= 0 && decideEnd > decideAt, 'decide() located');
    const decideBody = popupSrc.slice(decideAt, decideEnd);
    assert.equal((decideBody.match(/persistDone\(\);/g) || []).length, 2, 'persisted on interested + uninterested only');
    assert.equal((popupSrc.match(/persistDone\(\);/g) || []).length, 2, 'no persistDone call site anywhere else');
    assert.ok(decideBody.includes('markLaterSession();'), 'Maybe later stays session-only');
  });
  check('FIX3: server-meta suppression sets the in-memory guard and never persists', () => {
    const at = popupSrc.indexOf('if (meta.showClaimPrompt === false');
    assert.ok(at >= 0, 'suppression branch located');
    const branch = popupSrc.slice(at, at + 500);
    assert.ok(branch.includes('visitAnswered = true;'), 'in-memory page-load guard set');
    assert.ok(!branch.includes('persistDone'), 'suppression never persists the done flag');
    assert.ok(!branch.includes('setItem'), 'suppression writes no storage at all');
  });
  check('FIX3: export snippet now loads claim-preview.js?v=8', () => {
    assert.ok(kitSrc.includes('claim-preview.js?v=8'), 'claimKit injects ?v=8');
    assert.ok(!kitSrc.includes('claim-preview.js?v=7'), 'old ?v=7 gone');
  });

  console.log(JSON.stringify({ file: 'domain-payment-email-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'domain-payment-email-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
