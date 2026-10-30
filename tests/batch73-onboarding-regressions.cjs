'use strict';
/**
 * Batch 73 — client onboarding pack hosted at /onboarding + linked from
 * the domain flow's payment-received email (Ely, 2026-10-29: "add it as
 * a link in the email when a user subscribes [while] their website is
 * in progress").
 *
 *   Part A — the hosted page file: public/onboarding.html carries the
 *     pack's CLIENT sections only. The pack source also contains an
 *     internal staff run sheet (a .staff-zone block); every marker of
 *     it must be ABSENT from the hosted file, and the footer colophon
 *     must be the client-appropriate text.
 *   Part B — HTTP against the real server booted on temp DBs (batch58/
 *     70 pattern): GET /onboarding, /onboarding/ and /onboarding.html
 *     all serve 200 with the welcome headline + the "What we need from
 *     you" checklist and NO staff markers; /landing and /thankyou stay
 *     green.
 *   Part C — the payment-received email (domainFlow, vm-loaded with a
 *     stubbed stripeClient resolver like the Batch 36 harness): the
 *     client email gains ONE onboarding section — a "While we build
 *     your website" paragraph + a CTA built from the Batch 56 public
 *     URL resolver (no hardcoded domain). Rendered through the real
 *     branded template, '/onboarding' appears exactly once in the HTML
 *     part and exactly once in the text part; the Batch 36 once-only
 *     markPaid dedupe still prevents any resend.
 *
 * Negative proofs: re-adding the staff block (or either marker string)
 * to public/onboarding.html fails A/B; dropping the CTA from
 * composeClientPaymentEmail fails C; a second hardcoded domain literal
 * in domainFlow.js fails the census check in C.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b73-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch73', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31473;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

const STAFF_MARKERS = ['staff-zone', 'For the BitPype team', 'running this onboarding', 'internal run sheet'];
const CLIENT_MARKERS = [
  'live &amp; ringing.',
  'What happens next',
  'What we need from you',
  'Your portal, in five minutes',
  'Go-live day',
  'Your first 30 days',
  'Getting help',
  'keep both handy during your first month',
];

/* ===================================================================== */
/* Part A — the hosted page file                                          */
/* ===================================================================== */

function partA() {
  const pagePath = path.join(root, 'public/onboarding.html');
  check('A: public/onboarding.html exists', () => {
    assert.ok(fs.existsSync(pagePath), 'public/onboarding.html present');
  });
  const page = fs.readFileSync(pagePath, 'utf8');

  check('A: page carries every client section of the pack', () => {
    for (const marker of CLIENT_MARKERS) {
      assert.ok(page.includes(marker), `client content present: ${marker}`);
    }
    assert.ok(page.includes('<h1>Welcome aboard.'), 'welcome headline is the pack h1');
  });

  check('A: page contains NO staff run-sheet content', () => {
    for (const marker of STAFF_MARKERS) {
      assert.ok(!page.includes(marker), `staff marker absent: ${marker}`);
    }
    assert.ok(!page.includes('Two-week check-in scheduled'), 'staff checklist items absent');
    assert.ok(!page.includes('Client sections may be sent as-is'), 'old internal colophon absent');
  });

  check('A: server.js routes /onboarding + /onboarding.html through the templated sender', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(
      serverSrc.includes("app.get(['/onboarding', '/onboarding/']"),
      'clean /onboarding route registered'
    );
    assert.ok(
      serverSrc.includes("app.get('/onboarding.html', (_req, res) => sendTemplatedPage(res, 'onboarding.html'))"),
      'direct .html path intercepted like the other templated pages'
    );
    assert.ok(
      serverSrc.includes("return sendTemplatedPage(res, 'onboarding.html');"),
      'route serves onboarding.html via sendTemplatedPage'
    );
  });
}

/* ===================================================================== */
/* Part B — HTTP against the real server                                  */
/* ===================================================================== */

async function partB() {
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

    const getText = async (p) => {
      const res = await fetch(BASE + p);
      return { status: res.status, text: await res.text() };
    };

    for (const p of ['/onboarding', '/onboarding/', '/onboarding.html']) {
      await checkAsync(`B: GET ${p} → 200 with the client pack and no staff content`, async () => {
        const r = await getText(p);
        assert.equal(r.status, 200);
        for (const marker of CLIENT_MARKERS) {
          assert.ok(r.text.includes(marker), `served content present: ${marker}`);
        }
        for (const marker of STAFF_MARKERS) {
          assert.ok(!r.text.includes(marker), `served staff marker absent: ${marker}`);
        }
        assert.ok(!r.text.includes('{{'), 'zero token leakage');
      });
    }

    await checkAsync('B: /landing and /thankyou still serve 200', async () => {
      assert.equal((await getText('/landing')).status, 200);
      assert.equal((await getText('/thankyou')).status, 200);
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

/* ===================================================================== */
/* Part C — payment-received email gains the onboarding link              */
/* ===================================================================== */

function loadDomainFlow() {
  const module = { exports: {} };
  const mocks = {
    '../src/cfDomains': {
      normalizeDomain: (d) => {
        const s = String(d || '').trim().toLowerCase();
        return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
      },
      ensureTables: () => {},
    },
    '../src/outreach': {
      verifyInterestToken: (token) => {
        const [w, l, a] = String(token || '').split('.');
        const action = a === 'd' ? 'domain' : a === 'c' ? 'claim' : a === 'u' ? 'uninterested' : 'interested';
        if (!w || !l || !a) throw Object.assign(new Error('Invalid response link'), { code: 'INVALID_TOKEN' });
        return { workspaceId: Number(w), leadId: Number(l), action };
      },
      getSetting: (d, key, fb) => (key === 'smtp.from_email' ? 'team@bitpype.test' : fb || ''),
    },
    '../src/claimKit': { buildDomainPickerUrl: (w, l) => `https://bitpype.test/domain-picker.html?t=${w}.${l}.d` },
    './plans': require(path.join(root, 'server/plans.js')),
    './appUrls': { staffUrl: (route, params) => `https://bitpype.test/app#/${route}?txn=${params.txn}` },
    // The Batch 56 single resolver, stubbed to the test origin.
    './stripeClient': { appUrl: () => 'https://bitpype.test' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/domainFlow.js'), 'utf8'), {
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
  }, { filename: 'server/domainFlow.js' });
  return module.exports;
}

async function partC() {
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
  const df = loadDomainFlow();
  df.ensureTables(db);

  const platformStub = {
    getPlatformSetting: async (key, fb) => (key === 'billing.amount_label_standard' ? 'Standard · $99/mo' : fb || ''),
  };

  db.prepare('INSERT INTO leads (id, business_name, email, phone, status) VALUES (?, ?, ?, ?, ?)').run(
    731, 'Fixture Onboarding Co', 'owner@fixture.test', '5550001111', 'engaged'
  );
  db.prepare('INSERT INTO websites (lead_id, name, preview_url) VALUES (?, ?, ?)').run(
    731, 'Fixture Onboarding Site', ''
  );
  const siteId = db.prepare('SELECT id FROM websites WHERE lead_id = ?').get(731).id;
  const txn = df.createTransaction(db, {
    leadId: 731, websiteId: siteId, domain: 'fixtureonboarding.com',
    registrarPriceCents: 1299, registrarCurrency: 'USD', planId: 'standard',
  });
  const session = {
    id: 'cs_test_73',
    metadata: { domain_transaction_id: String(txn.id), domain_workspace_id: '1' },
    subscription: 'sub_73',
    customer: 'cus_73',
    amount_total: 9900,
  };
  const sent = [];
  const sendMail = async (mail) => { sent.push(mail); return { sent: true }; };

  let clientMail = null;
  await checkAsync('C: paid fires exactly one client email carrying the onboarding CTA', async () => {
    const res = await df.onDomainCheckoutPaid(session, { openDb: () => db, sendMail, platform: platformStub });
    assert.equal(res.ok, true);
    assert.equal(df.getTransaction(db, txn.id).status, 'paid');
    const clients = sent.filter((m) => m.to === 'owner@fixture.test');
    assert.equal(clients.length, 1, 'exactly one client payment email');
    clientMail = clients[0];
    assert.equal(clientMail.subject, 'Payment received for fixtureonboarding.com');
    assert.equal(clientMail.cta && clientMail.cta.url, 'https://bitpype.test/onboarding',
      'CTA URL built from the Batch 56 public-URL resolver + /onboarding');
    assert.equal(clientMail.cta && clientMail.cta.label, 'Read your onboarding pack');
    const body = clientMail.paragraphs.join('\n');
    assert.ok(body.includes('While we build your website'), 'while-we-build line present');
    assert.ok(body.includes('your onboarding pack explains what happens next'), 'pack explainer copy present');
    assert.ok(
      body.includes("We're registering fixtureonboarding.com and putting your site live."),
      'pre-existing next-step copy untouched'
    );
  });

  check('C: rendered email contains /onboarding exactly once per part', () => {
    const { renderBrandedEmail } = require(path.join(root, 'src/emailTemplate.js'));
    const rendered = renderBrandedEmail({
      title: clientMail.title,
      paragraphs: clientMail.paragraphs,
      text: clientMail.text,
      cta: clientMail.cta,
    });
    const count = (s) => (String(s).match(/\/onboarding/g) || []).length;
    assert.equal(count(rendered.html), 1, 'exactly one /onboarding in the HTML part');
    assert.equal(count(rendered.text), 1, 'exactly one /onboarding in the text part');
    assert.ok(rendered.html.includes('href="https://bitpype.test/onboarding"'), 'HTML CTA href');
    assert.ok(rendered.text.includes('Read your onboarding pack: https://bitpype.test/onboarding'), 'text CTA line');
  });

  await checkAsync('C: duplicate paid call resends nothing — dedupe intact, link still sent exactly once overall', async () => {
    const dup = await df.onDomainCheckoutPaid(session, { openDb: () => db, sendMail, platform: platformStub });
    assert.equal(dup.duplicate, true);
    assert.equal(sent.filter((m) => m.to === 'owner@fixture.test').length, 1, 'client email still exactly once');
  });

  check('C: census guard — no hardcoded domain literal added to domainFlow.js', () => {
    const dfSrc = fs.readFileSync(path.join(root, 'server/domainFlow.js'), 'utf8');
    assert.equal((dfSrc.match(/bitpype\.com/g) || []).length, 0, 'zero domain literals in domainFlow.js');
    assert.ok(dfSrc.includes('${publicAppBase()}/onboarding'), 'onboarding URL built from publicAppBase()');
  });
}

/* ===================================================================== */

async function main() {
  partA();
  await partB();
  await partC();
  console.log(JSON.stringify({ file: 'batch73-onboarding-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'batch73-onboarding-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
