'use strict';
/**
 * Batch 38 — the app owns the domain registrant contact (Ely, 2026-10-28,
 * after the live go-live failed at Cloudflare with "No registrant contact
 * provided and no default address book entry found for this account"):
 *
 *   1. SETTINGS — PLATFORM_SETTING_DEFS carries ten domain.registrant_*
 *      keys (group 'domains'; Admin → Settings → Domains tab renders
 *      them); settingsKeys makes every one settable + validated (the
 *      Batch 24b meta-test requires a validator per def).
 *   2. BUILDER — cfDomains.buildRegistrantContact maps the settings to
 *      the Cloudflare Registrar `registrant_contact` object (snake_case
 *      first_name/last_name/organization/email/phone/address/city/
 *      state/zip/country; postal_code → zip; country uppercased;
 *      organization optional + omitted when blank). Any missing required
 *      setting throws REGISTRANT_INCOMPLETE naming each missing setting
 *      and pointing at Admin → Settings → Domains.
 *   3. REGISTER PRE-FLIGHT — registerDomain builds the contact BEFORE
 *      any Cloudflare call: complete settings → the registrations POST
 *      carries registrant_contact; incomplete → zero HTTP calls and the
 *      actionable error. domainFlow.completeTransaction surfaces that
 *      error in the transaction's register step + error field, never
 *      advancing to live and never creating a site_domains row.
 *   4. SEARCH DECOUPLED — searchDomains / checkDomains never consult the
 *      registrant contact: with every registrant setting blank they
 *      still return priced results (the staff-page incident was the Buy
 *      action's REGISTER error rendering in the search card's message
 *      slot, not a search failure).
 *
 * The CF HTTP layer is stubbed by patching node:https.request BEFORE
 * cfDomains is required (cfDomains calls https.request at call time).
 * No real network, no real registrations.
 *
 * Negative proofs: dropping registrant_contact from the register body
 * fails the register checks; placing any registrar call before the
 * pre-flight (or moving the builder out of the register path) fails on
 * the HTTP-call accounting; removing a def or its validator fails the
 * settings checks; making organization required fails the builder check.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

/* ---------------- CF HTTP stub (installed before cfDomains loads) -------- */
const httpCalls = [];
let httpsPatch;
{
  const https = require('node:https');
  const realRequest = https.request;
  httpsPatch = { restore: () => (https.request = realRequest) };
  https.request = (options, cb) => {
    const chunks = [];
    const req = new EventEmitter();
    req.write = (c) => chunks.push(Buffer.from(c));
    req.destroy = () => {};
    req.end = () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = null;
      }
      httpCalls.push({ method: options.method, path: options.path, body });
      let payload;
      if (options.path.includes('/registrar/domain-search')) {
        payload = {
          success: true,
          result: {
            domains: [
              {
                name: 'registrant-probe.com',
                registrable: true,
                pricing: { currency: 'USD', registration_cost: 10.46, renewal_cost: 10.46 },
              },
            ],
          },
        };
      } else if (options.path.includes('/registrar/domain-check')) {
        const names = (body && body.domains) || [];
        payload = {
          success: true,
          result: {
            domains: names.map((name) => ({
              name,
              registrable: true,
              pricing: { currency: 'USD', registration_cost: 10.46, renewal_cost: 10.46 },
            })),
          },
        };
      } else if (options.path.includes('/registrar/registrations')) {
        payload = { success: true, result: { state: 'succeeded', completed: true } };
      } else {
        payload = { success: true, result: {} };
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(payload)));
        res.emit('end');
      });
    };
    return req;
  };
}

const cfDomains = require(path.join(root, 'src/cfDomains.js'));

/* ---------------- fixtures ---------------- */
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const FULL_SETTINGS = {
  'domain.registrant_first_name': 'Ely',
  'domain.registrant_last_name': 'Ayertey',
  'domain.registrant_organization': 'BitPype',
  'domain.registrant_email': 'owner@bitpype.test',
  'domain.registrant_phone': '+1 610 555 0123',
  'domain.registrant_address': '112 N Mill St',
  'domain.registrant_city': 'Birdsboro',
  'domain.registrant_state': 'PA',
  'domain.registrant_postal_code': '19508',
  'domain.registrant_country': 'us',
};
const EXPECTED_CONTACT = {
  first_name: 'Ely',
  last_name: 'Ayertey',
  organization: 'BitPype',
  email: 'owner@bitpype.test',
  phone: '+1 610 555 0123',
  address: '112 N Mill St',
  city: 'Birdsboro',
  state: 'PA',
  zip: '19508',
  country: 'US',
};

function makeDb(settings) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('cf.api_token', 'fixture-token-not-a-real-secret');
  put.run('cf.account_id', ACCOUNT_ID);
  for (const [k, v] of Object.entries(settings || {})) put.run(k, v);
  cfDomains.ensureTables(db);
  return db;
}

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

async function main() {
  /* ---------- 1-2: settings defs + validators ---------- */
  const platform = require(path.join(root, 'server/platform.js'));
  const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
  const registrantDefs = platform.PLATFORM_SETTING_DEFS.filter((d) => d.key.startsWith('domain.registrant_'));

  check('defs: all ten domain.registrant_* keys exist in group "domains", plain (non-secret)', () => {
    assert.equal(registrantDefs.length, 10, 'expected 10 registrant defs, got ' + registrantDefs.length);
    for (const d of registrantDefs) {
      assert.equal(d.group, 'domains', d.key + ' group');
      assert.ok(!d.secret, d.key + ' must not be secret');
    }
    const country = registrantDefs.find((d) => d.key === 'domain.registrant_country');
    assert.equal(country.default, 'US', 'country defaults to US');
  });

  check('settingsKeys: every registrant key is settable and validates (defaults + real values)', () => {
    for (const d of registrantDefs) {
      assert.ok(settingsKeys.SETTABLE_KEYS.includes(d.key), d.key + ' in SETTABLE_KEYS');
      const vDef = settingsKeys.validateSetting(d.key, d.default);
      assert.equal(vDef.ok, true, d.key + ' accepts its default: ' + (vDef && vDef.error));
    }
    assert.deepEqual(settingsKeys.validateSetting('domain.registrant_country', 'us'), { ok: true, value: 'US' });
    assert.equal(settingsKeys.validateSetting('domain.registrant_country', 'USA').ok, false);
    assert.equal(settingsKeys.validateSetting('domain.registrant_email', 'not-an-email').ok, false);
    assert.equal(settingsKeys.validateSetting('domain.registrant_email', 'owner@bitpype.test').ok, true);
    assert.equal(settingsKeys.validateSetting('domain.registrant_email', '').ok, true, 'blank allowed at save time');
  });

  check('Admin UI: Settings has a Domains tab whose section binds every registrant key', () => {
    const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc.includes("['domains', 'Domains', 'sec-domains']"), 'SETTINGS_TABS entry');
    assert.ok(appSrc.includes('id="sec-domains"'), 'sec-domains section');
    for (const d of registrantDefs) {
      assert.ok(appSrc.includes(`f('${d.key}'`), 'field rendered for ' + d.key);
    }
  });

  /* ---------- 3-4: the builder ---------- */
  const resolverFrom = (map) => (key) => map[key] || '';

  await checkAsync('builder: complete settings → exact Cloudflare registrant_contact shape', async () => {
    const contact = await cfDomains.buildRegistrantContact(resolverFrom(FULL_SETTINGS));
    assert.deepEqual(contact, EXPECTED_CONTACT);
  });

  await checkAsync('builder: organization is optional and omitted when blank', async () => {
    const map = { ...FULL_SETTINGS, 'domain.registrant_organization': '  ' };
    const contact = await cfDomains.buildRegistrantContact(resolverFrom(map));
    assert.ok(!('organization' in contact), 'no organization key when blank');
    assert.equal(contact.email, EXPECTED_CONTACT.email);
  });

  await checkAsync('builder: each missing required setting is named, with the fix location', async () => {
    for (const f of cfDomains.REGISTRANT_FIELDS.filter((x) => x.required)) {
      const map = { ...FULL_SETTINGS, [f.setting]: '' };
      await assert.rejects(
        () => cfDomains.buildRegistrantContact(resolverFrom(map)),
        (e) => {
          assert.equal(e.code, 'REGISTRANT_INCOMPLETE');
          assert.ok(e.message.includes(f.setting), 'message names ' + f.setting + ': ' + e.message);
          assert.ok(e.message.includes('Admin → Settings → Domains'), 'message points at the settings tab');
          assert.ok(Array.isArray(e.missing) && e.missing.length === 1, 'exactly one missing entry');
          return true;
        },
        'missing ' + f.setting
      );
    }
  });

  /* ---------- 5-6: register path over stubbed HTTP ---------- */
  await checkAsync('register: complete settings → registrations POST carries registrant_contact', async () => {
    httpCalls.length = 0;
    const db = makeDb(FULL_SETTINGS);
    const r = await cfDomains.registerDomain(db, 'registrant-probe.com', {});
    assert.equal(r.status, 'registered');
    assert.equal(httpCalls.length, 2, 'check + register, got ' + httpCalls.length);
    const reg = httpCalls.find((c) => c.path.includes('/registrar/registrations'));
    assert.ok(reg, 'registrations call made');
    assert.equal(reg.body.domain_name, 'registrant-probe.com');
    assert.deepEqual(reg.body.registrant_contact, EXPECTED_CONTACT);
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('registrant-probe.com');
    assert.ok(row && row.status === 'registered', 'site_domains row recorded');
    db.close();
  });

  await checkAsync('register: incomplete settings → zero HTTP calls, actionable error, no row', async () => {
    httpCalls.length = 0;
    const partial = { ...FULL_SETTINGS };
    delete partial['domain.registrant_email'];
    const db = makeDb(partial);
    await assert.rejects(
      () => cfDomains.registerDomain(db, 'registrant-probe.com', {}),
      (e) => {
        assert.equal(e.code, 'REGISTRANT_INCOMPLETE');
        assert.ok(e.message.includes('domain.registrant_email'), 'names the missing setting');
        assert.ok(e.message.includes('Admin → Settings → Domains'), 'points at the fix location');
        assert.ok(!/address book/i.test(e.message), 'not the raw registrar error');
        return true;
      }
    );
    assert.equal(httpCalls.length, 0, 'NO Cloudflare call may be made with a partial contact');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('registrant-probe.com');
    assert.equal(row, undefined, 'no site_domains row');
    db.close();
  });

  /* ---------- 7: search/check decoupled from registrant state ---------- */
  await checkAsync('search + check: work with every registrant setting blank', async () => {
    httpCalls.length = 0;
    const db = makeDb({});
    const s = await cfDomains.searchDomains(db, 'dumpster rental reading');
    assert.equal(s.domains.length, 1);
    assert.equal(s.domains[0].domain, 'registrant-probe.com');
    assert.equal(s.domains[0].registrationCost, 10.46);
    const c = await cfDomains.checkDomains(db, ['registrant-probe.com']);
    assert.equal(c.domains[0].registrable, true);
    assert.ok(httpCalls.length >= 2, 'registrar was actually queried');
    db.close();
  });

  /* ---------- 8-9: domainFlow completion surfaces the pre-flight ---------- */
  const domainFlow = require(path.join(root, 'server/domainFlow.js'));
  function makeFlowDb(settings) {
    const db = makeDb(settings);
    db.exec(`
      CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, status TEXT);
      CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, preview_url TEXT, custom_domain TEXT, status TEXT);
    `);
    db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1, 'Fixture Biz', 'client@fixture.test')").run();
    domainFlow.ensureTables(db);
    const info = db
      .prepare(
        `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status, amount_paid_cents)
         VALUES (1, NULL, 'registrant-flow.com', 'standard', 'paid', 9900)`
      )
      .run();
    return { db, txnId: Number(info.lastInsertRowid) };
  }

  await checkAsync('domainFlow: incomplete settings → register step records the actionable error, never live', async () => {
    httpCalls.length = 0;
    const partial = { ...FULL_SETTINGS };
    delete partial['domain.registrant_phone'];
    const { db, txnId } = makeFlowDb(partial);
    const out = await domainFlow.completeTransaction(db, 1, txnId, {});
    assert.equal(out.completed, false);
    assert.ok(out.error.includes('domain.registrant_phone'), 'txn error names the missing setting: ' + out.error);
    assert.ok(out.error.includes('Admin → Settings → Domains'), 'txn error points at the fix');
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.notEqual(txn.status, 'live', 'status does not advance to live');
    const steps = JSON.parse(txn.steps_json || '[]');
    const reg = steps.find((s) => s.step === 'register');
    assert.ok(reg && reg.ok === false, 'register step recorded as failed');
    assert.ok(reg.detail.includes('REGISTRANT') || reg.detail.includes('registrant contact is incomplete'), 'step detail is the actionable message');
    assert.equal(httpCalls.length, 0, 'zero registrar calls');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_domains').get().n, 0, 'no site_domains row');
    db.close();
  });

  await checkAsync('domainFlow: complete settings → register step succeeds with the contact on the wire', async () => {
    httpCalls.length = 0;
    const { db, txnId } = makeFlowDb(FULL_SETTINGS);
    const out = await domainFlow.completeTransaction(db, 1, txnId, {});
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    const steps = JSON.parse(txn.steps_json || '[]');
    const reg = steps.find((s) => s.step === 'register');
    assert.ok(reg && reg.ok === true, 'register step ok (later link step may fail on the bare fixture): ' + JSON.stringify(steps));
    const regCall = httpCalls.find((c) => c.path.includes('/registrar/registrations'));
    assert.ok(regCall, 'registrations call made');
    assert.deepEqual(regCall.body.registrant_contact, EXPECTED_CONTACT);
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('registrant-flow.com');
    assert.ok(row && row.status === 'registered', 'domain recorded as registered');
    assert.ok(out.error == null || !/registrant/i.test(out.error), 'no registrant error anywhere');
    db.close();
  });

  httpsPatch.restore();
  console.log(JSON.stringify({ file: 'domain-registrant-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'domain-registrant-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
