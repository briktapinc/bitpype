'use strict';
/**
 * Batch 43 — DNS pointing is a STEP, and "Live" must be earned (Ely,
 * 2026-10-28, pointing at the go-live Completion checklist and the
 * staff "Link a domain to a site" tool: "it should be included in
 * these steps"). Batch 42 put the record ensure inside
 * linkDomainToWebsite; the Berks transaction still showed all four
 * checklist boxes ticked — Payment received / Domain registered /
 * Site published & domain linked / Live — on a name that resolved
 * nowhere. Batch 43:
 *
 *   1. FLOW — domainFlow.completeTransaction runs an explicit `dns`
 *      step between `register` and `link`. The step owns the Batch 42
 *      ensure for this flow (the link keeps its own ensure for the
 *      manual paths; idempotent, so dns + link create the record
 *      exactly once) and then VERIFIES resolution via
 *      cfDomains.verifyDomainResolves: Pages reports the domain
 *      active, OR a public resolver (DNS-over-HTTPS) answers.
 *   2. STATE MODEL for "pointed but not resolving yet": neither live
 *      nor failed. The dns step records ok:false with the honest
 *      pending detail, the transaction returns to 'paid' (the
 *      Complete button's resumable state), error stays null, no live
 *      step, no live email. Re-clicking Complete resumes safely:
 *      register skips via its site_domains state, the ensure no-ops,
 *      the link re-runs idempotently, and once a witness resolves the
 *      transaction goes live. A hard DNS failure (403 token scope,
 *      conflict) still lands the transaction 'failed' with the
 *      guidance — on the dns step now, and the link never runs.
 *   3. CHECKLIST — the staff transaction page gains a "DNS pointed at
 *      the site" line bound to the dns step's recorded state, between
 *      Registered and Linked; the Live line stays bound to the true
 *      live status only.
 *   4. LINK TOOL — the helper copy says attaching includes pointing
 *      the domain's DNS at the site, and the success message surfaces
 *      the dns outcome (record created vs already pointed). The route
 *      already returns linkDomainToWebsite's result untouched (dns
 *      included) and its fail() preserves the error message — pinned
 *      structurally so a future refactor can't silently drop either.
 *
 * CF HTTP + DoH are stubbed by patching node:https.request BEFORE
 * cfDomains loads (the Batch 42 pattern). The verification window is
 * injected (deps.dnsVerify with a no-op sleep) — no real waiting, no
 * real network.
 *
 * Negative proofs (run during development, restored after):
 *   - removing the dns step block from completeTransaction fails the
 *     ordering check (no dns step in steps_json);
 *   - neutering the not-resolved branch (forcing live without
 *     verification) fails the pending check (transaction goes live).
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

/* ---------------- HTTP stub (CF API + DoH) ---------------- */
const httpCalls = [];
let dnsRecords = []; // records the fake zone currently holds
let dnsPostAuth403 = false; // Registrar+Pages-only token (no Zone DNS Edit)
let pagesDomainStatus = 'active'; // status the fake Pages project reports
let dohAnswers = false; // whether the fake public resolver answers
const ZONE_ID = 'zone43fixture0000000000000000abcd';
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
      httpCalls.push({ host: options.host || '', method: options.method, path: options.path, body });
      let status = 200;
      let payload;
      const p = options.path;
      if (options.host === 'cloudflare-dns.com') {
        payload = dohAnswers
          ? {
              Status: 0,
              Answer: [
                { name: 'dns-step.com', type: 5, TTL: 60, data: 'bp-w1-s1.pages.dev.' },
                { name: 'dns-step.com', type: 1, TTL: 60, data: '172.67.0.10' },
              ],
            }
          : { Status: 0, Question: [{ name: 'dns-step.com', type: 1 }] };
      } else if (p.includes('/dns_records') && options.method === 'GET') {
        payload = { success: true, result: dnsRecords };
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
        payload =
          options.method === 'GET'
            ? { success: true, result: [{ name: 'dns-step.com', status: pagesDomainStatus }] }
            : { success: true, result: { name: body && body.name, status: 'pending' } };
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
const domainFlow = require(path.join(root, 'server/domainFlow.js'));

/* ---------------- fixtures ---------------- */
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const DOMAIN = 'dns-step.com';
const PROJECT = 'bp-w1-s1';
const TARGET = `${PROJECT}.pages.dev`;

function resetHttp(records) {
  httpCalls.length = 0;
  dnsRecords = records || [];
  dnsPostAuth403 = false;
  pagesDomainStatus = 'active';
  dohAnswers = false;
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

function makeFlowDb() {
  const db = makeDb();
  domainFlow.ensureTables(db);
  const info = db
    .prepare(
      `INSERT INTO domain_transactions (lead_id, website_id, domain, plan_id, status, amount_paid_cents)
       VALUES (1, 1, '${DOMAIN}', 'standard', 'paid', 9900)`
    )
    .run();
  // Registration already done — the register step skips; the row also
  // carries the Pages project the dns step resolves from.
  db.prepare(
    `INSERT INTO site_domains (website_id, lead_id, domain_name, status, source, pages_project, public_url)
     VALUES (1, 1, '${DOMAIN}', 'registered', 'registrar', '${PROJECT}', NULL)`
  ).run();
  return { db, txnId: Number(info.lastInsertRowid) };
}

// The verification window is injected: 3 attempts, no real waiting.
const flowDeps = (sent) => ({
  publishSite: async () => ({ ok: true }),
  sendMail: async (mail) => {
    sent.push(mail);
  },
  dnsVerify: { attempts: 3, intervalMs: 0, sleep: async () => {} },
});

const dnsPosts = () => httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/dns_records'));
const registerPosts = () => httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/registrar/registrations'));
const stepsOf = (db, txnId) =>
  JSON.parse(db.prepare('SELECT steps_json FROM domain_transactions WHERE id = ?').get(txnId).steps_json || '[]');

const results = [];
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
function check(name, fn) {
  fn();
  results.push(name);
}

async function main() {
  /* ---------- 1: ordering + create-once + live via Pages active ---------- */
  await checkAsync('flow: register → dns → link → live ordering; CNAME created exactly once; live only via Pages-active witness', async () => {
    resetHttp([]);
    pagesDomainStatus = 'active';
    dohAnswers = false;
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out.completed, true, 'flow completes: ' + JSON.stringify(out));
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.equal(txn.status, 'live');
    const steps = stepsOf(db, txnId);
    const idx = (n) => steps.findIndex((s) => s.step === n);
    assert.ok(idx('register') >= 0 && idx('dns') > idx('register'), 'dns step runs after register: ' + JSON.stringify(steps.map((s) => s.step)));
    assert.ok(idx('link') > idx('dns'), 'link runs after dns');
    assert.ok(idx('live') > idx('link'), 'live is recorded last');
    const dnsStep = steps[idx('dns')];
    assert.equal(dnsStep.ok, true, 'dns step ok');
    assert.ok(dnsStep.detail.includes('Pages reports the domain active'), 'dns detail names the witness: ' + dnsStep.detail);
    assert.ok(dnsStep.detail.includes('DNS record created'), 'dns detail says the record was created: ' + dnsStep.detail);
    assert.equal(dnsPosts().length, 1, 'exactly one CNAME POST across dns + link (the link ensure no-ops)');
    assert.deepEqual(dnsPosts()[0].body, { type: 'CNAME', name: DOMAIN, content: TARGET, proxied: true, ttl: 1 });
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(row && row.status === 'linked', 'site_domains linked after the dns step passed');
    assert.ok(sent.length >= 1, 'client live email sent');
    db.close();
  });

  /* ---------- 2: live via the DoH witness alone ---------- */
  await checkAsync('flow: Pages still pending but a public resolver answers → live via the DNS witness', async () => {
    resetHttp([]);
    pagesDomainStatus = 'pending';
    dohAnswers = true;
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out.completed, true, 'flow completes on the resolver witness: ' + JSON.stringify(out));
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.equal(txn.status, 'live');
    const dnsStep = stepsOf(db, txnId).find((s) => s.step === 'dns');
    assert.ok(dnsStep && dnsStep.ok === true);
    assert.ok(dnsStep.detail.includes('public DNS is answering'), 'dns detail names the resolver witness: ' + dnsStep.detail);
    db.close();
  });

  /* ---------- 3: pointed but not resolving → parked resumable, then live ---------- */
  await checkAsync('flow: record in place but nothing resolves → NOT live, back to paid, no error; re-click resumes to live without re-registering or re-POSTing', async () => {
    resetHttp([]);
    pagesDomainStatus = 'pending';
    dohAnswers = false;
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out1 = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out1.completed, false, 'first run does not complete');
    assert.equal(out1.pending, 'dns', 'first run reports the dns pending state');
    let txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.notEqual(txn.status, 'live', 'never live on an unresolving name');
    assert.equal(txn.status, 'paid', 'transaction returns to the resumable paid state (not failed)');
    assert.ok(!txn.error, 'no error recorded for a propagation wait: ' + txn.error);
    assert.ok(!txn.completed_at, 'completed_at not set');
    let steps = stepsOf(db, txnId);
    const dnsStep1 = steps.filter((s) => s.step === 'dns').pop();
    assert.ok(dnsStep1 && dnsStep1.ok === false, 'dns step recorded as not-yet');
    assert.ok(dnsStep1.detail.includes('not resolving yet'), 'dns detail is the honest pending message: ' + dnsStep1.detail);
    assert.equal(steps.find((s) => s.step === 'live'), undefined, 'no live step');
    assert.equal(steps.find((s) => s.step === 'link'), undefined, 'link does not run before the name resolves');
    assert.equal(sent.length, 0, 'no live email for an unresolving name');
    const siteBefore = db.prepare('SELECT custom_domain FROM websites WHERE id = 1').get();
    assert.ok(!siteBefore.custom_domain, 'website not marked with the domain yet');
    assert.equal(dnsPosts().length, 1, 'the record WAS created by the dns step');

    // "Propagation" lands; the admin clicks Complete again.
    pagesDomainStatus = 'active';
    const out2 = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out2.completed, true, 'second run completes: ' + JSON.stringify(out2));
    txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.equal(txn.status, 'live');
    steps = stepsOf(db, txnId);
    const dnsSteps = steps.filter((s) => s.step === 'dns');
    assert.equal(dnsSteps[dnsSteps.length - 1].ok, true, 'latest dns step ok on resume');
    assert.ok(dnsSteps[dnsSteps.length - 1].detail.includes('already in place'), 'resume sees the existing record: ' + dnsSteps[dnsSteps.length - 1].detail);
    assert.equal(dnsPosts().length, 1, 'still exactly one CNAME POST across both runs — resume never re-creates');
    assert.equal(registerPosts().length, 0, 'registration never re-runs (skipped via site_domains state in both runs)');
    assert.ok(sent.length >= 1, 'live email sent only once the name resolves');
    const siteAfter = db.prepare('SELECT custom_domain FROM websites WHERE id = 1').get();
    assert.equal(siteAfter.custom_domain, DOMAIN);
    db.close();
  });

  /* ---------- 4: hard DNS failure → failed on the dns step ---------- */
  await checkAsync('flow: DNS 403 → dns step fails with the token guidance, transaction failed, link never runs, never live', async () => {
    resetHttp([]);
    dnsPostAuth403 = true;
    const { db, txnId } = makeFlowDb();
    const sent = [];
    const out = await domainFlow.completeTransaction(db, 1, txnId, flowDeps(sent));
    assert.equal(out.completed, false);
    assert.equal(out.pending, undefined, 'a hard failure is not the pending state');
    const txn = db.prepare('SELECT * FROM domain_transactions WHERE id = ?').get(txnId);
    assert.equal(txn.status, 'failed');
    assert.ok(txn.error.includes('Zone → DNS → Edit'), 'txn error carries the token guidance: ' + txn.error);
    const steps = stepsOf(db, txnId);
    const dnsStep = steps.find((s) => s.step === 'dns');
    assert.ok(dnsStep && dnsStep.ok === false, 'dns step recorded as failed');
    assert.ok(dnsStep.detail.includes('Zone → DNS → Edit'), 'dns step detail is the actionable guidance');
    assert.equal(steps.find((s) => s.step === 'link'), undefined, 'link never runs');
    assert.equal(steps.find((s) => s.step === 'live'), undefined, 'no live step');
    assert.equal(sent.length, 0, 'no live email');
    db.close();
  });

  /* ---------- 5: verifyDomainResolves unit (injected readers/clock) ---------- */
  await checkAsync('verifyDomainResolves: witnesses, attempt counting, injected sleep — readers failing counts as not-yet, never success', async () => {
    const db = makeDb();
    const noSleep = async () => {};
    const viaDns = await cfDomains.verifyDomainResolves(db, DOMAIN, PROJECT, {
      attempts: 3,
      intervalMs: 0,
      sleep: noSleep,
      pagesStatus: async () => 'pending',
      dohLookup: async () => true,
    });
    assert.deepEqual(
      { resolved: viaDns.resolved, via: viaDns.via },
      { resolved: true, via: 'dns' },
      'resolver witness resolves'
    );
    const viaPages = await cfDomains.verifyDomainResolves(db, DOMAIN, PROJECT, {
      attempts: 3,
      intervalMs: 0,
      sleep: noSleep,
      pagesStatus: async () => 'active',
      dohLookup: async () => false,
    });
    assert.equal(viaPages.via, 'pages', 'Pages-active witness resolves');
    let sleeps = 0;
    const never = await cfDomains.verifyDomainResolves(db, DOMAIN, PROJECT, {
      attempts: 3,
      intervalMs: 5,
      sleep: async () => {
        sleeps += 1;
      },
      pagesStatus: async () => 'pending',
      dohLookup: async () => false,
    });
    assert.equal(never.resolved, false, 'no witness → not resolved');
    assert.equal(never.attempts, 3, 'all attempts used');
    assert.equal(sleeps, 2, 'sleeps only between attempts');
    const throwing = await cfDomains.verifyDomainResolves(db, DOMAIN, PROJECT, {
      attempts: 2,
      intervalMs: 0,
      sleep: noSleep,
      pagesStatus: async () => {
        throw new Error('pages read boom');
      },
      dohLookup: async () => {
        throw new Error('doh boom');
      },
    });
    assert.equal(throwing.resolved, false, 'reader errors are not-yet, never success');
    db.close();
  });

  /* ---------- 6: checklist wiring (structural) ---------- */
  check('checklist: staff transaction page has the DNS line bound to the dns step, between Registered and Linked; Live bound to the live status only', () => {
    const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc.includes("const dnsStep = stepState('dns')"), 'checklist reads the dns step state');
    const iReg = appSrc.indexOf("checkRow('Domain registered at Cloudflare'");
    const iDns = appSrc.indexOf("checkRow('DNS pointed at the site'");
    const iLink = appSrc.indexOf("checkRow('Site published & domain linked'");
    const iLive = appSrc.indexOf("checkRow('Live'");
    assert.ok(iReg >= 0 && iDns > iReg, 'DNS line renders after the Registered line');
    assert.ok(iLink > iDns, 'DNS line renders before the Linked line');
    assert.ok(iLive > iLink, 'Live line renders last');
    assert.ok(
      appSrc.includes("checkRow('Live', t.status === 'live'"),
      'the Live line is checked only by the true live status'
    );
    assert.ok(
      appSrc.includes("checkRow('DNS pointed at the site', dnsStep && dnsStep.ok ? dnsStep : null"),
      'the DNS line is checked only by an ok dns step'
    );
  });

  /* ---------- 7: link tool surface (structural) ---------- */
  check('link tool: copy states DNS pointing is included; form + row actions surface the dns outcome; route returns the link result and preserves error messages', () => {
    const appSrc = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(
      appSrc.includes("the domain's DNS is pointed at the site"),
      'helper copy says attaching includes pointing the DNS at the site'
    );
    assert.ok(appSrc.includes('r.data.dns'), 'link form reads the dns outcome from the response');
    assert.ok(appSrc.includes('DNS record created'), 'link form reports a created record');
    assert.ok(appSrc.includes('DNS already pointed at'), 'link form reports an already-pointed record');
    assert.ok(appSrc.includes('d.pending'), 'txn-complete surfaces the dns pending state instead of a failure toast');

    const apiSrc = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
    assert.ok(apiSrc.includes("router.post('/domains/link'"), 'staff link route exists');
    assert.ok(apiSrc.includes('domain.domainsLink(req.auth.workspaceId'), 'route delegates to domainsLink');
    const linkRoute = apiSrc.slice(apiSrc.indexOf("router.post('/domains/link'"));
    assert.ok(
      linkRoute.slice(0, 400).includes('fail(res, e, 500)'),
      'route failure path passes the original error to fail() — the Batch 42/43 guidance is not swallowed into a generic message'
    );

    const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
    assert.ok(
      domainSrc.includes('return mod.linkDomainToWebsite(db, {'),
      'domainsLink returns the linkDomainToWebsite result untouched — the dns summary reaches the UI'
    );
  });

  httpsPatch.restore();
  console.log(JSON.stringify({ file: 'domain-dns-step-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'domain-dns-step-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
