'use strict';
/**
 * Batch 77 — SMS policy page + consent line on phone-collecting forms
 * (Ely, 2026-10-30: "Add sms policy link and page wherever text field
 * options are available for people to provide, I'll use this link on
 * twilio").
 *
 *   Part A — the single source (server/smsPolicy.js): the policy URL
 *     comes from the one public-URL resolver (stripeClient.appUrl),
 *     the consent microcopy is Ely's exact text with "SMS Policy" as
 *     the link text, and the /sms-policy page file carries every
 *     Twilio A2P clause (program, opt-in paths, frequency, rates,
 *     STOP/HELP, carrier liability, the no-sharing sentence verbatim).
 *     sms-policy.html is NOT in the Batch 75 disclaimer opt-in map.
 *   Part B — HTTP against the real server on temp DBs: /sms-policy
 *     and /sms-policy.html serve 200 with every clause and NO
 *     disclaimer block; /landing and /website-promo serve the consent
 *     line with the resolver-built absolute link (disclaimer intact);
 *     the public payloads carry the sms_policy block exactly where a
 *     phone number is collected (contact form WITH phone, bookings,
 *     estimate, chatbot) and nowhere else (contact form WITHOUT phone,
 *     members); a fixture submission still succeeds with the line
 *     present (submission behavior unchanged).
 *   Part C — rendered output (Puppeteer): a fixture page mounting the
 *     real embed scripts the way an exported site does shows the
 *     consent note in the phone form, the booking form, the estimate
 *     form and the chat lead form — and NOT in the phoneless form —
 *     and the phone form still submits successfully end to end.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b77-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch77', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31477;
const BASE = `http://127.0.0.1:${PORT}`;
const POLICY_URL = 'https://bitpype.test/sms-policy';
const CONSENT_TEXT =
  'By providing your phone number, you agree to receive text messages about your inquiry or appointment ' +
  'from this business, sent via BitPype. Msg & data rates may apply. Reply STOP to end. See our SMS Policy.';
const SHARING_SENTENCE =
  'Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. ' +
  'Text messaging originator opt-in data and consent will not be shared with any third parties.';

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
const count = (s, sub) => String(s).split(sub).length - 1;

/* ===================================================================== */
/* Part A — single source + page file                                     */
/* ===================================================================== */

function partA() {
  const smsPolicy = require(path.join(root, 'server', 'smsPolicy.js'));

  check('A: policy URL is built from the single resolver (appUrl + /sms-policy)', () => {
    assert.equal(smsPolicy.POLICY_PATH, '/sms-policy');
    assert.equal(smsPolicy.policyUrl(), POLICY_URL);
  });

  check('A: consent microcopy is exact; the HTML twin links "SMS Policy" to the policy URL', () => {
    assert.equal(smsPolicy.consentText(), CONSENT_TEXT);
    const html = smsPolicy.consentHtml();
    assert.ok(html.includes(`<a href="${POLICY_URL}"`), 'absolute resolver-built link');
    assert.ok(html.includes('>SMS Policy</a>.'), 'link text is exactly "SMS Policy"');
    const stripped = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    assert.equal(stripped, CONSENT_TEXT, 'HTML and text twins agree word for word');
    const block = smsPolicy.policyBlock();
    assert.equal(block.url, POLICY_URL);
    assert.equal(block.html, html);
  });

  check('A: /sms-policy is a legal-family page — NOT in the Batch 75 disclaimer opt-in map', () => {
    const md = require(path.join(root, 'server', 'marketingDisclaimer.js'));
    assert.ok(!('sms-policy.html' in md.TEMPLATED_PAGE_SCHEMES), 'no disclaimer scheme for sms-policy');
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(src.includes("app.get(['/sms-policy', '/sms-policy/']"), 'clean route registered');
    assert.ok(src.includes("app.get('/sms-policy.html'"), '.html intercept registered');
    assert.ok(src.includes("sendTemplatedPage(res, 'sms-policy.html')"), 'served via the templated sender');
  });

  check('A: the page file carries every A2P clause and no baked domain', () => {
    const page = fs.readFileSync(path.join(root, 'public', 'sms-policy.html'), 'utf8');
    for (const pin of [
      'Appointment and booking messages',
      'Missed-call follow-up',
      'Estimate follow-up',
      'Service and order notifications',
      "call a business's published phone number",
      'submit a form that includes your phone number',
      'Message frequency varies',
      'Message and data rates may apply',
      '<strong>STOP</strong>',
      '<strong>HELP</strong>',
      'carriers are not liable for delayed or undelivered messages',
      'business you contacted',
      'sent via BitPype',
    ]) {
      assert.ok(page.includes(pin), `page pin: ${pin}`);
    }
    assert.ok(page.includes(SHARING_SENTENCE), 'no-sharing sentence verbatim');
    assert.ok(!page.includes('bitpype.com'), 'no hardcoded domain in the page (Batch 56 census)');
    assert.ok(page.includes('{{PUBLIC_URL}}'), 'contact link is a serve-time token');
  });

  check('A: first-party form files carry the consent line with a token-built link', () => {
    for (const rel of ['public/landing.html', 'public/website-promo.html']) {
      const html = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.ok(html.includes('href="{{PUBLIC_URL}}/sms-policy"'), `${rel}: token-built policy link`);
      assert.ok(
        html.includes('By providing your phone number, you agree to receive text messages'),
        `${rel}: consent copy present`
      );
      assert.ok(html.includes('Reply STOP to end'), `${rel}: STOP wording present`);
    }
  });

  check('A: embed renderers place the line from the payload block (source pins)', () => {
    const formEmbed = fs.readFileSync(path.join(root, 'public', 'js', 'form-embed.js'), 'utf8');
    assert.ok(formEmbed.includes('form.sms_policy'), 'form-embed consumes sms_policy');
    assert.ok(formEmbed.includes('bp-sms-policy-note'), 'form-embed renders the note');
    const moduleEmbed = fs.readFileSync(path.join(root, 'public', 'js', 'module-embed.js'), 'utf8');
    assert.equal(count(moduleEmbed, 'smsPolicyRow(data) +'), 2, 'booking + estimate renderers place the row');
    const chatEmbed = fs.readFileSync(path.join(root, 'public', 'js', 'chat-embed.js'), 'utf8');
    assert.ok(chatEmbed.includes('bp-chat-lead-sms-policy'), 'chat-embed carries the policy element');
    assert.ok(chatEmbed.includes('data.sms_policy'), 'chat-embed fills it from the payload');
  });

  check('A: payload wiring — the block rides with sms_optin in all three payload builders', () => {
    const cf = fs.readFileSync(path.join(root, 'server', 'contactForms.js'), 'utf8');
    assert.ok(cf.includes("form.sms_policy = form.sms_optin ? require('./smsPolicy').policyBlock() : null"));
    const sm = fs.readFileSync(path.join(root, 'server', 'siteModules.js'), 'utf8');
    assert.ok(sm.includes("out.sms_policy = require('./smsPolicy').policyBlock()"));
    const cb = fs.readFileSync(path.join(root, 'server', 'chatbot.js'), 'utf8');
    assert.ok(cb.includes('sms_policy: smsPolicyBlock'));
  });
}

/* ===================================================================== */
/* Seed + Part B — HTTP against the real server                           */
/* ===================================================================== */

const fixture = {};

async function seed() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'SMS Policy Fixture', 'sms-policy-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  fixture.wdb = wdb;
  wdb
    .prepare("INSERT INTO leads (id, business_name, email, status) VALUES (1, 'Fixture Plumbing Co', 'owner@fixture.test', 'new')")
    .run();

  const contactForms = require(path.join(root, 'server', 'contactForms.js'));
  const withPhone = contactForms.createForm(wdb, 1, {
    name: 'Contact (phone)',
    fields: [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1 },
      { field_key: 'phone', label: 'Phone', field_type: 'tel', required: 0 },
      { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1 },
    ],
  });
  contactForms.publishForm(wdb, 1, withPhone.id, { workspaceId: 1 });
  fixture.formPhoneToken = contactForms.getFormById(wdb, 1, withPhone.id).public_token;
  const noPhone = contactForms.createForm(wdb, 1, {
    name: 'Contact (no phone)',
    fields: [
      { field_key: 'name', label: 'Name', field_type: 'text', required: 1 },
      { field_key: 'email', label: 'Email', field_type: 'email', required: 1 },
      { field_key: 'message', label: 'Message', field_type: 'textarea', required: 1 },
    ],
  });
  contactForms.publishForm(wdb, 1, noPhone.id, { workspaceId: 1 });
  fixture.formNoPhoneToken = contactForms.getFormById(wdb, 1, noPhone.id).public_token;

  const siteModules = require(path.join(root, 'server', 'siteModules.js'));
  siteModules.ensureTables(wdb);
  fixture.bookingsToken = siteModules.ensureEmbed(wdb, 1, 'bookings', { workspaceId: 1 }).public_token;
  siteModules.createBookingService(wdb, 1, {
    name: 'Fixture Service',
    duration_minutes: 30,
    price_cents: 0,
    status: 'published',
  });
  fixture.estimateToken = siteModules.ensureEmbed(wdb, 1, 'estimate', { workspaceId: 1 }).public_token;
  fixture.membersToken = siteModules.ensureEmbed(wdb, 1, 'members', { workspaceId: 1 }).public_token;
  fixture.chatToken = siteModules.ensureEmbed(wdb, 1, 'chatbot', { workspaceId: 1 }).public_token;
  assert.ok(fixture.formPhoneToken && fixture.formNoPhoneToken, 'form tokens minted');
  assert.ok(fixture.bookingsToken && fixture.estimateToken && fixture.membersToken && fixture.chatToken, 'module tokens minted');
}

async function partB(getText, getJson, postJson) {
  for (const p of ['/sms-policy', '/sms-policy.html']) {
    await checkAsync(`B: GET ${p} → 200, every clause, NO disclaimer block`, async () => {
      const r = await getText(p);
      assert.equal(r.status, 200);
      for (const pin of [
        'SMS Policy',
        'Missed-call follow-up',
        'Estimate follow-up',
        'Message frequency varies',
        'Message and data rates may apply',
        'opt out',
        'HELP',
        'not liable for delayed or undelivered messages',
        SHARING_SENTENCE,
      ]) {
        assert.ok(r.text.includes(pin), `clause served on ${p}: ${pin}`);
      }
      assert.equal(count(r.text, 'bp-earnings-disclaimer'), 0, 'legal-family page carries no marketing disclaimer');
      assert.ok(!r.text.includes('{{'), 'no token leakage');
      assert.ok(r.text.includes('https://bitpype.test'), 'contact link resolved from the public URL');
    });
  }

  for (const p of ['/landing', '/website-promo']) {
    await checkAsync(`B: GET ${p} → consent line with resolver-built absolute link (disclaimer intact)`, async () => {
      const r = await getText(p);
      assert.equal(r.status, 200);
      assert.equal(count(r.text, `href="${POLICY_URL}"`), 1, `one policy link on ${p}`);
      assert.ok(r.text.includes('By providing your phone number, you agree to receive text messages'), 'consent copy');
      assert.ok(r.text.includes('Reply STOP to end. See our'), 'STOP wording before the link');
      assert.equal(count(r.text, 'bp-earnings-disclaimer'), 1, 'Batch 75 disclaimer still exactly once');
      assert.ok(!r.text.includes('{{'), 'no token leakage');
    });
  }

  await checkAsync('B: contact-form payload carries sms_policy exactly when a phone field exists', async () => {
    const withPhone = await getJson(`/api/v1/forms/public/${fixture.formPhoneToken}`);
    assert.equal(withPhone.status, 200);
    assert.ok(withPhone.json.data.sms_optin, 'opt-in block present (Batch 25 intact)');
    assert.ok(withPhone.json.data.sms_policy, 'sms_policy present with phone');
    assert.equal(withPhone.json.data.sms_policy.url, POLICY_URL);
    assert.ok(withPhone.json.data.sms_policy.html.includes('Reply STOP to end'));
    const noPhone = await getJson(`/api/v1/forms/public/${fixture.formNoPhoneToken}`);
    assert.equal(noPhone.status, 200);
    assert.equal(noPhone.json.data.sms_optin, null, 'no opt-in block without phone');
    assert.equal(noPhone.json.data.sms_policy, null, 'NO sms_policy without a phone field');
  });

  await checkAsync('B: bookings + estimate payloads carry sms_policy; members does not', async () => {
    for (const [label, token] of [
      ['bookings', fixture.bookingsToken],
      ['estimate', fixture.estimateToken],
    ]) {
      const r = await getJson(`/api/v1/modules/public/${token}`);
      assert.equal(r.status, 200, `${label} payload 200`);
      assert.ok(r.json.data.sms_policy, `${label} carries sms_policy`);
      assert.equal(r.json.data.sms_policy.url, POLICY_URL);
    }
    const members = await getJson(`/api/v1/modules/public/${fixture.membersToken}`);
    assert.equal(members.status, 200, 'members payload 200');
    assert.ok(!members.json.data.sms_policy, 'members signup collects no phone → no sms_policy');
  });

  await checkAsync('B: chatbot public config carries sms_policy', async () => {
    const r = await getJson(`/api/v1/chat/public/${fixture.chatToken}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.data.sms_policy, 'chat config carries sms_policy');
    assert.equal(r.json.data.sms_policy.url, POLICY_URL);
  });

  await checkAsync('B: fixture submission still succeeds with the consent line present (behavior unchanged)', async () => {
    const before = fixture.wdb.prepare('SELECT COUNT(*) AS n FROM form_submissions').get().n;
    const r = await postJson(`/api/v1/forms/public/${fixture.formPhoneToken}/submit`, {
      values: { name: 'Casey Fixture', email: 'casey@fixture.test', phone: '+15555550142', message: 'Need a quote' },
    });
    assert.equal(r.status, 200, `submit status ${r.status}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.ok, true);
    const after = fixture.wdb.prepare('SELECT COUNT(*) AS n FROM form_submissions').get().n;
    assert.equal(after, before + 1, 'submission recorded exactly once');
  });
}

/* ===================================================================== */
/* Part C — rendered output via the real embed scripts (Puppeteer)        */
/* ===================================================================== */

async function partC() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Fixture site</title><body>
      <div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="${fixture.formPhoneToken}" data-bitpype-api="${BASE}"></div>
      <div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="${fixture.formNoPhoneToken}" data-bitpype-api="${BASE}"></div>
      <div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-module-type="bookings" data-bitpype-module-token=<redacted> data-bitpype-api="${BASE}"></div>
      <div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-module-type="estimate" data-bitpype-module-token=<redacted> data-bitpype-api="${BASE}"></div>
      <div class="bitpype-chat-embed" data-bitpype-chat-token=<redacted></div>
      <script src="${BASE}/js/form-embed.js" defer></script>
      <script src="${BASE}/js/module-embed.js" defer></script>
      <script src="${BASE}/js/chat-embed.js" defer></script>
    </body>`;
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().startsWith('http://fixture.example/')) {
        return r.respond({ status: 200, contentType: 'text/html', body: fixtureHtml });
      }
      if (r.url().startsWith(BASE)) return r.continue();
      return r.abort();
    });
    await page.goto('http://fixture.example/', { waitUntil: 'domcontentloaded' });

    await checkAsync('C: phone contact form renders the consent note with the absolute policy link', async () => {
      const sel = `.bitpype-form-embed[data-bitpype-form-embed="${fixture.formPhoneToken}"] .bp-sms-policy-note`;
      await page.waitForSelector(sel, { timeout: 20000 });
      const got = await page.$eval(sel, (el) => ({
        text: el.textContent.replace(/\s+/g, ' ').trim(),
        href: el.querySelector('a') && el.querySelector('a').href,
      }));
      assert.equal(got.text, CONSENT_TEXT);
      assert.equal(got.href, POLICY_URL);
    });

    await checkAsync('C: phoneless contact form renders NO consent note', async () => {
      const wrap = `.bitpype-form-embed[data-bitpype-form-embed="${fixture.formNoPhoneToken}"]`;
      await page.waitForSelector(`${wrap} form`, { timeout: 20000 });
      assert.equal(await page.$(`${wrap} .bp-sms-policy-note`), null);
    });

    await checkAsync('C: booking form renders the consent note', async () => {
      const sel = `.bitpype-module-embed[data-bitpype-module-token=<redacted> .bp-sms-policy-note`;
      await page.waitForSelector(sel, { timeout: 20000 });
      const href = await page.$eval(sel, (el) => el.querySelector('a') && el.querySelector('a').href);
      assert.equal(href, POLICY_URL);
    });

    await checkAsync('C: estimate form renders the consent note', async () => {
      const sel = `.bitpype-module-embed[data-bitpype-module-token=<redacted> .bp-sms-policy-note`;
      await page.waitForSelector(sel, { timeout: 20000 });
      const href = await page.$eval(sel, (el) => el.querySelector('a') && el.querySelector('a').href);
      assert.equal(href, POLICY_URL);
    });

    await checkAsync('C: chat lead form fills + unhides the consent line from the payload', async () => {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.bp-chat-lead-sms-policy');
          return el && !el.hidden && el.querySelector('a');
        },
        { timeout: 20000 }
      );
      const href = await page.$eval('.bp-chat-lead-sms-policy', (el) => el.querySelector('a').href);
      assert.equal(href, POLICY_URL);
    });

    await checkAsync('C: the phone form still submits successfully end to end', async () => {
      const wrap = `.bitpype-form-embed[data-bitpype-form-embed="${fixture.formPhoneToken}"]`;
      const before = fixture.wdb.prepare('SELECT COUNT(*) AS n FROM form_submissions').get().n;
      await page.type(`${wrap} [name="name"]`, 'Browser Fixture');
      await page.type(`${wrap} [name="email"]`, 'browser@fixture.test');
      await page.type(`${wrap} [name="phone"]`, '+15555550143');
      await page.type(`${wrap} [name="message"]`, 'Browser-path submission');
      await page.click(`${wrap} button[type="submit"]`);
      await page.waitForFunction(
        (w) => {
          const el = document.querySelector(w);
          return el && /received|thanks/i.test(el.textContent);
        },
        { timeout: 20000 },
        wrap
      );
      const after = fixture.wdb.prepare('SELECT COUNT(*) AS n FROM form_submissions').get().n;
      assert.equal(after, before + 1, 'browser submission recorded');
    });

    check('C: no page errors from the embed scripts', () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
}

/* ===================================================================== */
/* Main                                                                   */
/* ===================================================================== */

(async () => {
  partA();
  await seed();

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
      const res = await fetch(BASE + p, { redirect: 'manual' });
      return { status: res.status, text: await res.text() };
    };
    const getJson = async (p) => {
      const res = await fetch(BASE + p);
      return { status: res.status, json: await res.json() };
    };
    const postJson = async (p, body) => {
      const res = await fetch(BASE + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };

    await partB(getText, getJson, postJson);
    await partC();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }

  console.log(JSON.stringify({ passed: true, checks: results.length, batch: 77 }));
  console.log(results.map((r) => '  ✓ ' + r).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
