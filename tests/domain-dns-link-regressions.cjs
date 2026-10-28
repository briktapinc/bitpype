'use strict';
/**
 * Batch 42 — a linked domain must actually resolve (Ely's first live
 * go-live, 2026-10-28: Berks txn 4 registered, attached to its Pages
 * project and marked LIVE, but the zone had ZERO DNS records and the
 * Pages custom-domain sat "pending" — attaching via the API does not
 * create DNS; the dashboard flow does it interactively):
 *
 *   1. LINK ENSURES DNS — cfDomains.linkDomainToWebsite, right after
 *      pagesAddDomain and BEFORE anything is marked linked, ensures the
 *      apex CNAME (<domain> → <project>.pages.dev, proxied, ttl 1)
 *      exists in the domain's zone, and reads it back to confirm.
 *      Idempotent: a correct CNAME already there = success, no POST.
 *   2. CONFLICTS ARE HONEST — an apex A/AAAA record (or a CNAME to a
 *      different target) fails the link with a DNS_CONFLICT naming the
 *      record. Nothing is deleted, nothing is overwritten, and the
 *      site is NOT marked linked.
 *   3. TOKEN SCOPE SURFACES — DNS calls need Zone → DNS → Edit; the
 *      Registrar + Pages token answers 403 code 10000 "Authentication
 *      error". That failure fails the link step with the actionable
 *      token guidance (Settings → Cloudflare, Zone → DNS → Edit), and
 *      end-to-end through domainFlow.completeTransaction the
 *      transaction lands 'failed' — NEVER 'live' on a dead name.
 *   4. READ-BACK — a create whose record cannot be seen on the
 *      follow-up GET fails as DNS_UNCONFIRMED instead of sailing on.
 *
 * The CF HTTP layer is stubbed by patching node:https.request BEFORE
 * cfDomains is required (cfDomains calls https.request at call time).
 * No real network, no real DNS.
 *
 * Negative proof: removing the ensurePagesDnsRecord call from
 * linkDomainToWebsite fails the create-when-absent checks (direct +
 * end-to-end) — without it nothing ever POSTs a DNS record.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
let dnsRecords = []; // records the fake zone currently holds (apex fixtures)
let dnsPostAuth403 = false; // simulate the Registrar+Pages-only token
let dnsVanishOnRead = false; // POST "succeeds" but the record never reads back
const ZONE_ID = 'zone42fixture0000000000000000abcd';
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
      let status = 200;
      let payload;
      const p = options.path;
      if (p.includes('/dns_records') && options.method === 'GET') {
        payload = { success: true, result: dnsVanishOnRead ? [] : dnsRecords };
      } else if (p.includes('/dns_records') && options.method === 'POST') {
        if (dnsPostAuth403) {
          status = 403;
          payload = { success: false, errors: [{ code: 10000, message: 'Authentication error' }] };
        } else {
          const rec = { id: 'rec' + (dnsRecords.length + 1), ...body };
          dnsRecords = [...dnsRecords, rec];
          payload = { success: true, result: rec };
        }
      } else if (p.startsWith('/client/v4/zones')) {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: [{ id: ZONE_ID, name }] };
      } else if (p.includes('/pages/projects/') && p.endsWith('/domains')) {
        // POST = attach; GET = list. Batch 43's flow dns step polls the
        // list to verify resolution — the fixture domain reports active,
        // like a name whose DNS already resolves.
        payload =
          options.method === 'GET'
            ? { success: true, result: [{ name: 'dns-link.com', status: 'active' }] }
            : { success: true, result: { name: body && body.name, status: 'pending' } };
      } else if (p.includes('/registrar/domain-check')) {
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
      } else if (p.includes('/registrar/registrations')) {
        payload = { success: true, result: { state: 'succeeded', completed: true } };
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

/* ---------------- fixtures ---------------- */
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const DOMAIN = 'dns-link.com';
const PROJECT = 'bp-w1-s1';
const TARGET = `${PROJECT}.pages.dev`;

function resetHttp(records) {
  httpCalls.length = 0;
  dnsRecords = records || [];
  dnsPostAuth403 = false;
  dnsVanishOnRead = false;
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('cf.api_token', 'fixture-token-not-a-real-secret');
  put.run('cf.account_id', ACCOUNT_ID);
  db.exec(`
    CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT, email TEXT, phone TEXT, status TEXT);
    CREATE TABLE websites (id INTEGER PRIMARY KEY, lead_id INTEGER, name TEXT, preview_url TEXT, custom_domain TEXT, status TEXT, updated_at TEXT);
  `);
  db.prepare("INSERT INTO leads (id, business_name, email) VALUES (1, 'Fixture Biz', 'client@fixture.test')").run();
  db.prepare(
    "INSERT INTO websites (id, lead_id, name, preview_url, status) VALUES (1, 1, 'Fixture Biz', 'https://bp-w1-s1.pages.dev', 'live')"
  ).run();
  cfDomains.ensureTables(db);
  return db;
}

const dnsPosts = () => httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/dns_records'));
const dnsDeletes = () => httpCalls.filter((c) => c.method === 'DELETE');

const results = [];
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

async function main() {
  /* ---------- 1: link creates the CNAME when absent ---------- */
  await checkAsync('link: no apex record → CNAME created with the documented body, then read back', async () => {
    resetHttp([]);
    const db = makeDb();
    const r = await cfDomains.linkDomainToWebsite(db, {
      domain: DOMAIN,
      websiteId: 1,
      leadId: 1,
      project: PROJECT,
      workspaceId: 1,
    });
    assert.equal(r.dns.created, true);
    assert.equal(r.dns.target, TARGET);
    const posts = dnsPosts();
    assert.equal(posts.length, 1, 'exactly one DNS create');
    assert.ok(posts[0].path.includes(`/zones/${ZONE_ID}/dns_records`), 'POST hits the zone records path: ' + posts[0].path);
    assert.deepEqual(posts[0].body, { type: 'CNAME', name: DOMAIN, content: TARGET, proxied: true, ttl: 1 });
    const gets = httpCalls.filter((c) => c.method === 'GET' && c.path.includes('/dns_records'));
    assert.ok(gets.length >= 2, 'initial lookup + read-back confirmation GETs, got ' + gets.length);
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(row && row.status === 'linked', 'site marked linked only after DNS confirmed');
    const site = db.prepare('SELECT custom_domain FROM websites WHERE id = 1').get();
    assert.equal(site.custom_domain, DOMAIN);
    db.close();
  });

  /* ---------- 2: idempotent when the correct CNAME exists ---------- */
  await checkAsync('link: correct CNAME already present → success, no POST, no DELETE', async () => {
    resetHttp([{ id: 'rec1', type: 'CNAME', name: DOMAIN, content: TARGET, proxied: true, ttl: 1 }]);
    const db = makeDb();
    const r = await cfDomains.linkDomainToWebsite(db, {
      domain: DOMAIN,
      websiteId: 1,
      leadId: 1,
      project: PROJECT,
      workspaceId: 1,
    });
    assert.equal(r.dns.created, false, 'nothing created');
    assert.equal(dnsPosts().length, 0, 'no DNS POST');
    assert.equal(dnsDeletes().length, 0, 'no DNS DELETE');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(row && row.status === 'linked');
    db.close();
  });

  /* ---------- 3: conflicting apex A record ---------- */
  await checkAsync('link: conflicting apex A record → DNS_CONFLICT, nothing created/deleted/marked', async () => {
    resetHttp([{ id: 'rec1', type: 'A', name: DOMAIN, content: '192.0.2.10', proxied: false, ttl: 300 }]);
    const db = makeDb();
    await assert.rejects(
      () =>
        cfDomains.linkDomainToWebsite(db, {
          domain: DOMAIN,
          websiteId: 1,
          leadId: 1,
          project: PROJECT,
          workspaceId: 1,
        }),
      (e) => {
        assert.equal(e.code, 'DNS_CONFLICT');
        assert.ok(e.message.includes('A record'), 'names the record type: ' + e.message);
        assert.ok(e.message.includes('192.0.2.10'), 'names the conflicting target: ' + e.message);
        return true;
      }
    );
    assert.equal(dnsPosts().length, 0, 'no DNS POST');
    assert.equal(dnsDeletes().length, 0, 'no DNS DELETE — existing DNS is never removed');
    assert.equal(dnsRecords.length, 1, 'the A record is untouched');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(!row || row.status !== 'linked', 'site NOT marked linked');
    const site = db.prepare('SELECT custom_domain FROM websites WHERE id = 1').get();
    assert.ok(!site.custom_domain, 'website custom_domain not set');
    db.close();
  });

  /* ---------- 4: 403 authentication error on the DNS POST ---------- */
  await checkAsync('link: DNS POST 403 code 10000 → fails with Zone → DNS → Edit token guidance', async () => {
    resetHttp([]);
    dnsPostAuth403 = true;
    const db = makeDb();
    await assert.rejects(
      () =>
        cfDomains.linkDomainToWebsite(db, {
          domain: DOMAIN,
          websiteId: 1,
          leadId: 1,
          project: PROJECT,
          workspaceId: 1,
        }),
      (e) => {
        assert.ok(e.message.includes('Zone'), 'guidance names Zone: ' + e.message);
        assert.ok(e.message.includes('DNS'), 'guidance names DNS: ' + e.message);
        assert.ok(e.message.includes('Edit'), 'guidance names Edit: ' + e.message);
        assert.ok(e.message.includes('Settings → Cloudflare'), 'guidance points at the settings screen');
        assert.ok(!/^Authentication error$/i.test(e.message.trim()), 'not the raw Cloudflare message');
        return true;
      }
    );
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(!row || row.status !== 'linked', 'site NOT marked linked');
    db.close();
  });

  /* ---------- 5: read-back honesty ---------- */
  await checkAsync('link: create accepted but record not visible on read-back → DNS_UNCONFIRMED', async () => {
    resetHttp([]);
    dnsVanishOnRead = true;
    const db = makeDb();
    await assert.rejects(
      () =>
        cfDomains.linkDomainToWebsite(db, {
          domain: DOMAIN,
          websiteId: 1,
          leadId: 1,
          project: PROJECT,
          workspaceId: 1,
        }),
      (e) => {
        assert.equal(e.code, 'DNS_UNCONFIRMED');
        return true;
      }
    );
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(!row || row.status !== 'linked', 'site NOT marked linked');
    db.close();
  });

  /* ---------- 6-7: domainFlow end-to-end ---------- */
  const domainFlow = require(path.join(root, 'server/domainFlow.js'));
  function makeFlowDb() {
    const db = makeDb();
    domainFlow.ensureTables(db);
    const info = db
      .prepare(
        `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status, amount_paid_cents)
         VALUES (1, 1, '${DOMAIN}', 'standard', 'paid', 9900)`
      )
      .run();
    // Registration already done in an earlier attempt — the register step
    // skips, the link step must run (row is 'registered', not 'linked').
    db.prepare(
      `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, pages_project, public_url)
       VALUES (1, 1, '${DOMAIN}', 'registered', 'registrar', '${PROJECT}', NULL)`
    ).run();
    return { db, txnId: Number(info.lastInsertRowid) };
  }
  const flowDeps = (sent) => ({
    publishSite: async () => ({ ok: true }),
    sendMail: async (mail) => {
      sent.push(mail);
    },
  });

  await checkAsync('domainFlow: DNS ensured (Batch 43: in its own dns step) → transaction reaches live, client emailed', async () => {
    resetHttp([]);
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out.completed, true, 'flow completes: ' + JSON.stringify(out));
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.equal(txn.status, 'live');
    const steps = JSON.parse(txn.steps_json || '[]');
    const link = steps.find((s) => s.step === 'link');
    assert.ok(link && link.ok === true, 'link step ok: ' + JSON.stringify(steps));
    const posts = dnsPosts();
    assert.equal(posts.length, 1, 'the link created the apex CNAME');
    assert.deepEqual(posts[0].body, { type: 'CNAME', name: DOMAIN, content: TARGET, proxied: true, ttl: 1 });
    assert.ok(sent.length >= 1, 'client live email sent');
    db.close();
  });

  await checkAsync('domainFlow: DNS 403 → dns step fails with scope guidance, transaction NEVER live', async () => {
    resetHttp([]);
    dnsPostAuth403 = true;
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out.completed, false);
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.notEqual(txn.status, 'live', 'a transaction must never go live on an unresolvable domain');
    assert.equal(txn.status, 'failed');
    assert.ok(txn.error.includes('Zone') && txn.error.includes('DNS') && txn.error.includes('Edit'), 'txn error carries the token guidance: ' + txn.error);
    const steps = JSON.parse(txn.steps_json || '[]');
    // Batch 43: DNS is its own step — the failure is recorded there and
    // the link step never runs.
    const dnsStep = steps.find((s) => s.step === 'dns');
    assert.ok(dnsStep && dnsStep.ok === false, 'dns step recorded as failed');
    assert.ok(dnsStep.detail.includes('Zone → DNS → Edit'), 'step detail is the actionable guidance');
    assert.equal(steps.find((s) => s.step === 'link'), undefined, 'link step never runs when DNS fails');
    assert.equal(steps.find((s) => s.step === 'live'), undefined, 'no live step recorded');
    assert.equal(sent.length, 0, 'no "your site is live" email for a dead name');
    db.close();
  });

  httpsPatch.restore();
  console.log(JSON.stringify({ file: 'domain-dns-link-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'domain-dns-link-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
