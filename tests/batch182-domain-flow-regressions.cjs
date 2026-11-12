'use strict';
/**
 * Batch 182 — domain flow fixes (Ely, 2026-11-11: "Add all to domain
 * fix batch", from the live berksjournal.com purchase):
 *
 *   1. OWNED LIED BY OMISSION — domains.owned read the DEPRECATED
 *      legacy registrar list (proven live to answer [] while domains
 *      exist), so a fresh buyer saw {"domains":[]} while domains.list
 *      showed the domain. Owned is now the workspace's own
 *      site_domains records (the same source as list) enriched with
 *      registrar facts — the fixture domain appears, and a second
 *      workspace sharing the same registrar account sees NOTHING of
 *      it (no leakage either direction).
 *   2. EXPIRY / AUTO-RENEW INVISIBLE — expires_at / renewal_* stayed
 *      NULL after registration. Registration now captures the
 *      registrar-reported expiry at completion; status captures it
 *      too; owned/list reads refresh registrar facts onto the rows
 *      (TTL-cached on renewal_checked_at: a second read inside the
 *      TTL makes NO registrar call).
 *   3. WWW SKIPPED + MISLEADING ZONE ERROR — link set up the apex
 *      only, and linking www failed with "No DNS zone for
 *      www.<domain>" because the lookup used the full subdomain as
 *      the zone name. Zone lookup now walks to the registrable
 *      domain, the error names the zone actually looked for, and an
 *      apex link also provisions www (Pages custom domain — www
 *      SERVES the site — plus its proxied CNAME). A www failure is
 *      reported in the link result, never silent, never fatal to a
 *      working apex.
 *   4. CHECK CLARITY — domains.check rows now carry an explicit
 *      `available` flag and a first-year total (`firstYearTotal`,
 *      aliased `total`); every pre-existing field is unchanged.
 *
 * The CF HTTP layer is stubbed by patching node:https.request BEFORE
 * cfDomains is required. No real network.
 *
 * Negative proofs: reverting listOwnedDomains to the legacy list
 * fails check 1 (the stub's legacy endpoint answers [] forever);
 * reverting the zone walk fails check 5 (www lookup finds no zone);
 * removing the www block from linkDomainToWebsite fails check 6.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

/* ---------------- CF HTTP stub (installed before cfDomains loads) -------- */
const httpCalls = [];
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ZONE_ID = 'zone182fixture0000000000000000ab';
const ZONES = new Set(['fixture182.com', 'reg182.com', 'newreg182.com', 'link182.com', 'conflict182.com']);
let registrationsList = [];
let dnsRecords = [];
let pagesAttached = [];
{
  const https = require('node:https');
  const realRequest = https.request;
  https.request = (options, cb) => {
    const chunks = [];
    const req = new EventEmitter();
    req.write = (c) => chunks.push(Buffer.from(c));
    req.destroy = () => {};
    req.end = () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        body = null;
      }
      httpCalls.push({ method: options.method, path: options.path, body });
      const p = options.path;
      let status = 200;
      let payload;
      if (p.includes('/registrar/domain-check')) {
        const names = (body && body.domains) || [];
        payload = {
          success: true,
          result: {
            domains: names.map((name) =>
              name === 'taken182.com'
                ? { name, registrable: false, reason: 'Already registered', pricing: { currency: 'USD' } }
                : {
                    name,
                    registrable: true,
                    pricing: { currency: 'USD', registration_cost: 11.17, renewal_cost: 11.17 },
                  }
            ),
          },
        };
      } else if (p.includes('/registration-status')) {
        payload = { success: true, result: { state: 'succeeded', completed: true } };
      } else if (p.includes('/registrar/registrations') && options.method === 'GET') {
        payload = { success: true, result: registrationsList, result_info: {} };
      } else if (p.includes('/registrar/registrations') && options.method === 'POST') {
        payload = {
          success: true,
          result: {
            state: 'succeeded',
            completed: true,
            context: { registration: { expires_at: '2027-11-12T00:00:00Z', auto_renew: false } },
          },
        };
      } else if (p.includes('/registrar/domains')) {
        // The deprecated legacy list: answers EMPTY, forever — the
        // exact live behaviour that made domains.owned lie.
        payload = { success: true, result: [] };
      } else if (p.startsWith('/client/v4/zones?')) {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: ZONES.has(name) ? [{ id: ZONE_ID, name }] : [] };
      } else if (p.includes('/dns_records') && options.method === 'GET') {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: dnsRecords.filter((r) => r.name === name) };
      } else if (p.includes('/dns_records') && options.method === 'POST') {
        const rec = { id: 'rec' + (dnsRecords.length + 1), ...body };
        dnsRecords = [...dnsRecords, rec];
        payload = { success: true, result: rec };
      } else if (p.includes('/pages/projects/') && p.endsWith('/domains')) {
        if (options.method === 'GET') {
          payload = { success: true, result: pagesAttached };
        } else {
          pagesAttached = [...pagesAttached, { name: body && body.name, status: 'pending' }];
          payload = { success: true, result: { name: body && body.name, status: 'pending' } };
        }
      } else {
        payload = { success: true, result: {} };
      }
      const res = new EventEmitter();
      res.statusCode = status;
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

const REGISTRANT = {
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

function makeDb(extraSettings) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('cf.api_token', 'fixture-token-not-a-real-secret');
  put.run('cf.account_id', ACCOUNT_ID);
  for (const [k, v] of Object.entries(extraSettings || {})) put.run(k, v);
  db.exec(`
    CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, status TEXT);
    CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, preview_url TEXT, custom_domain TEXT, status TEXT, updated_at TEXT);
  `);
  cfDomains.ensureTables(db);
  return db;
}

function resetHttp() {
  httpCalls.length = 0;
  registrationsList = [];
  dnsRecords = [];
  pagesAttached = [];
}

const regListGets = () =>
  httpCalls.filter((c) => c.method === 'GET' && c.path.includes('/registrar/registrations')).length;
const dnsPosts = () => httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/dns_records'));
const pagesPosts = () =>
  httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/pages/projects/') && c.path.endsWith('/domains'));

const results = [];
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
  console.log('  ok -', name);
}

async function main() {
  /* ---------- 1: owned tells the truth, scoped to the workspace ---------- */
  await checkAsync('owned: local registration appears (legacy list answers []), enriched + written back', async () => {
    resetHttp();
    registrationsList = [
      { domain_name: 'fixture182.com', status: 'active', expires_at: '2027-03-01T00:00:00Z', auto_renew: true },
    ];
    const db = makeDb();
    db.prepare(
      `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, registration_state)
       VALUES (7, 5, 'fixture182.com', 'registered', 'registrar', 'succeeded')`
    ).run();
    const owned = await cfDomains.listOwnedDomains(db);
    assert.equal(owned.domains.length, 1, 'the purchased domain must appear in owned');
    const d = owned.domains[0];
    assert.equal(d.domain, 'fixture182.com');
    assert.equal(d.expiresAt, '2027-03-01T00:00:00Z', 'expiry enriched from the registrar');
    assert.equal(d.autoRenew, true, 'registrar auto_renew enriched');
    assert.equal(d.websiteId, 7);
    assert.equal(d.leadId, 5);
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('fixture182.com');
    assert.equal(row.expires_at, '2027-03-01T00:00:00Z', 'expiry written back onto the record');
    assert.ok(row.renewal_checked_at, 'renewal_checked_at stamped by the refresh');
    db.close();
  });

  await checkAsync('owned: no cross-workspace leakage in either direction', async () => {
    resetHttp();
    registrationsList = [
      { domain_name: 'fixture182.com', status: 'active', expires_at: '2027-03-01T00:00:00Z', auto_renew: true },
      { domain_name: 'other182.com', status: 'active', expires_at: '2027-05-01T00:00:00Z', auto_renew: false },
    ];
    // Workspace B: same registrar account, NO local records → sees nothing.
    const dbB = makeDb();
    const ownedB = await cfDomains.listOwnedDomains(dbB);
    assert.deepEqual(ownedB.domains, [], "another workspace must not see this workspace's domains");
    dbB.close();
    // Workspace C: owns other182.com only → sees exactly that one.
    const dbC = makeDb();
    dbC.prepare(
      `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, registration_state)
       VALUES (9, 6, 'other182.com', 'registered', 'registrar', 'succeeded')`
    ).run();
    const ownedC = await cfDomains.listOwnedDomains(dbC);
    assert.equal(ownedC.domains.length, 1);
    assert.equal(ownedC.domains[0].domain, 'other182.com');
    assert.equal(ownedC.domains[0].expiresAt, '2027-05-01T00:00:00Z');
    dbC.close();
  });

  await checkAsync('owned: read refresh is TTL-cached — second read makes no registrar call', async () => {
    resetHttp();
    registrationsList = [
      { domain_name: 'fixture182.com', status: 'active', expires_at: '2027-03-01T00:00:00Z', auto_renew: true },
    ];
    const db = makeDb();
    db.prepare(
      `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, registration_state)
       VALUES (7, 5, 'fixture182.com', 'registered', 'registrar', 'succeeded')`
    ).run();
    await cfDomains.listOwnedDomains(db);
    const afterFirst = regListGets();
    assert.ok(afterFirst >= 1, 'first read consults the registrar');
    const again = await cfDomains.listOwnedDomains(db);
    assert.equal(again.domains.length, 1);
    assert.equal(regListGets(), afterFirst, 'second read inside the TTL is served from the record');
    db.close();
  });

  /* ---------- 2: expiry + renewal state at registration / status ---------- */
  await checkAsync('register: registrar-reported expiry is captured on the record at completion', async () => {
    resetHttp();
    const db = makeDb(REGISTRANT);
    const r = await cfDomains.registerDomain(db, 'newreg182.com', { years: 1, websiteId: 3, leadId: 4 });
    assert.equal(r.status, 'registered');
    assert.equal(r.expiresAt, '2027-11-12T00:00:00Z', 'register result carries the expiry');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('newreg182.com');
    assert.equal(row.expires_at, '2027-11-12T00:00:00Z', 'record carries the expiry from day one');
    assert.ok(row.renewal_checked_at, 'record stamped as checked at registration');
    db.close();
  });

  await checkAsync('status: succeeded check flips the row and returns expiry + renewal state', async () => {
    resetHttp();
    registrationsList = [
      { domain_name: 'reg182.com', status: 'active', expires_at: '2027-06-15T00:00:00Z', auto_renew: false },
    ];
    const db = makeDb();
    db.prepare(
      `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, registration_state)
       VALUES (3, 4, 'reg182.com', 'registering', 'registrar', 'in_progress')`
    ).run();
    const st = await cfDomains.registrationStatus(db, 'reg182.com');
    assert.equal(st.state, 'succeeded');
    assert.equal(st.status, 'registered');
    assert.equal(st.expiresAt, '2027-06-15T00:00:00Z', 'status returns the expiry, not just the workflow state');
    assert.equal(st.renewalAutoRenew, false, 'status returns the registrar auto_renew state');
    assert.ok(st.renewalCheckedAt, 'status returns when renewal state was last verified');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('reg182.com');
    assert.equal(row.expires_at, '2027-06-15T00:00:00Z');
    db.close();
  });

  /* ---------- 3: zone walk + honest error + www provisioning ---------- */
  await checkAsync('zone walk: www lookup resolves the registrable zone', async () => {
    resetHttp();
    const db = makeDb();
    const r = await cfDomains.ensurePagesDnsRecord(db, 'www.fixture182.com', 'bp-w1-s9');
    assert.equal(r.target, 'bp-w1-s9.pages.dev');
    assert.equal(r.created, true);
    const zoneGets = httpCalls.filter((c) => c.method === 'GET' && c.path.startsWith('/client/v4/zones?'));
    assert.ok(
      zoneGets.some((c) => c.path.includes('name=fixture182.com')),
      'the walk reached the registrable zone name'
    );
    assert.equal(dnsPosts().length, 1);
    assert.equal(dnsPosts()[0].body.name, 'www.fixture182.com');
    db.close();
  });

  await checkAsync('zone error: names the registrable zone actually looked for', async () => {
    resetHttp();
    const db = makeDb();
    await assert.rejects(
      () => cfDomains.ensurePagesDnsRecord(db, 'www.absent-domain.com', 'bp-w1-s9'),
      (e) => {
        assert.equal(e.code, 'ZONE_NOT_FOUND');
        assert.ok(e.message.includes('absent-domain.com'), 'names the zone: ' + e.message);
        assert.ok(
          e.message.includes('the zone that www.absent-domain.com belongs to'),
          'explains the walk instead of blaming the subdomain: ' + e.message
        );
        return true;
      }
    );
    db.close();
  });

  await checkAsync('link: apex link also provisions www (Pages attach + CNAME), reported in the result', async () => {
    resetHttp();
    const db = makeDb();
    db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1, 'Fixture Biz', 'client@fixture.test')").run();
    db.prepare(
      "INSERT INTO websites (id, lead_id, name, preview_url, status) VALUES (1, 1, 'Fixture Biz', 'https://bp-w1-s1.pages.dev', 'live')"
    ).run();
    const r = await cfDomains.linkDomainToWebsite(db, {
      domain: 'link182.com',
      websiteId: 1,
      leadId: 1,
      project: 'bp-w1-s1',
      workspaceId: 1,
    });
    assert.equal(r.domain, 'link182.com');
    const attachedNames = pagesPosts().map((c) => c.body && c.body.name);
    assert.ok(attachedNames.includes('link182.com'), 'apex attached to Pages');
    assert.ok(attachedNames.includes('www.link182.com'), 'www attached to Pages');
    const dnsNames = dnsPosts().map((c) => c.body && c.body.name);
    assert.ok(dnsNames.includes('link182.com'), 'apex CNAME created');
    assert.ok(dnsNames.includes('www.link182.com'), 'www CNAME created');
    assert.ok(r.www && r.www.attached === true, 'www reported attached');
    assert.equal(r.www.name, 'www.link182.com');
    assert.equal(r.www.serves, 'pages', 'www serves the site via the Pages custom domain');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('link182.com');
    assert.equal(row.status, 'linked');
    db.close();
  });

  await checkAsync('link: a www DNS conflict is reported in the result — the apex still links', async () => {
    resetHttp();
    dnsRecords = [{ id: 'recW', type: 'A', name: 'www.conflict182.com', content: '192.0.2.55', proxied: false, ttl: 300 }];
    const db = makeDb();
    db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1, 'Fixture Biz', 'client@fixture.test')").run();
    db.prepare(
      "INSERT INTO websites (id, lead_id, name, preview_url, status) VALUES (1, 1, 'Fixture Biz', 'https://bp-w1-s1.pages.dev', 'live')"
    ).run();
    const r = await cfDomains.linkDomainToWebsite(db, {
      domain: 'conflict182.com',
      websiteId: 1,
      leadId: 1,
      project: 'bp-w1-s1',
      workspaceId: 1,
    });
    assert.equal(r.domain, 'conflict182.com', 'apex link succeeds despite the www conflict');
    assert.ok(r.www && r.www.attached === false, 'www reported NOT attached');
    assert.ok(/already has a A record/.test(r.www.error || ''), 'www error names the conflict: ' + r.www.error);
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get('conflict182.com');
    assert.equal(row.status, 'linked', 'apex row linked');
    db.close();
  });

  /* ---------- 4: check clarity ---------- */
  await checkAsync('check: explicit available flag + first-year total, legacy fields unchanged', async () => {
    resetHttp();
    const db = makeDb();
    const c = await cfDomains.checkDomains(db, ['fixture182.com', 'taken182.com']);
    const free = c.domains.find((d) => d.domain === 'fixture182.com');
    const taken = c.domains.find((d) => d.domain === 'taken182.com');
    assert.equal(free.available, true, 'available flag true for a registrable name');
    assert.equal(free.registrable, true, 'registrable unchanged');
    assert.equal(free.registrationCost, 11.17, 'registrationCost unchanged');
    assert.equal(free.firstYearTotal, 11.17, 'first-year total present');
    assert.equal(free.total, 11.17, 'total alias present');
    assert.equal(taken.available, false, 'available flag false for a taken name');
    assert.equal(taken.registrable, false);
    assert.equal(taken.firstYearTotal, null, 'no total for an unavailable name');
    db.close();
  });

  console.log(`batch182-domain-flow-regressions: ${results.length} checks passed`);
}

main().catch((e) => {
  console.error('batch182-domain-flow-regressions FAILED:', e);
  process.exit(1);
});
