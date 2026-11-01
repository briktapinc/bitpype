'use strict';
/**
 * Batch 44 — a linked domain must be the SEO base of the export that
 * publishes it (app-wide review, 2026-10-28: Berks Roll-Off went live
 * at dumpsterrentalreadingberks.com, but its canonical tag, all 35
 * sitemap URLs and the robots.txt Sitemap line pointed at a
 * per-deployment Pages host — eacb2819.bp-w1-s21.pages.dev — leaking
 * the rank-and-rent asset's ranking signals to a throwaway host):
 *
 *   ROOT CAUSE — linkDomainToWebsite runs publishFn BEFORE it writes
 *   websites.custom_domain / site_domains, so the export produced
 *   during a link-with-publish derived its SEO base from the stale
 *   preview_url. On top of that, a per-deployment preview host
 *   (<hash>.<project>.pages.dev) was used verbatim as a base even
 *   though it trails the live deployment by one.
 *
 *   FIX A (override) — linkDomainToWebsite passes the domain being
 *   linked to publishFn as { seoBaseUrl }, threaded through every
 *   publish funnel (server/domain.js domainsLink + domainFlowComplete
 *   → materializeWebsiteExport; server/domainFlow.js forwards it;
 *   IPC + MCP parity funnels → exportStatic) into
 *   buildSeoExportContext, where it wins over every derived base for
 *   that export only. A failed publish changes no stored state — the
 *   site never claims a domain it doesn't have.
 *
 *   FIX B (hardening) — when the base falls back to a per-deployment
 *   pages.dev preview URL, buildSeoExportContext collapses the host
 *   to the stable project subdomain (<project>.pages.dev). Custom
 *   domain and site_domains bases are unaffected.
 *
 * The CF HTTP layer is stubbed by patching node:https.request BEFORE
 * cfDomains is required (same pattern as domain-dns-link-regressions).
 * No real network.
 *
 * Negative proof: dropping the seoBaseUrl pass-through in
 * linkDomainToWebsite (publishFn called without the link context)
 * fails check 1 — the export falls back to the per-deployment host.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || process.env.DB_DRIVER || 'sqlite';
process.env.EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-seo-base-exports-'));

const root = path.resolve(__dirname, '..');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

/* ---------------- CF HTTP stub (installed before cfDomains loads) -------- */
const httpCalls = [];
let dnsRecords = [];
const ZONE_ID = 'zone44fixture0000000000000000abcd';
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
      const p = options.path;
      if (p.includes('/dns_records') && options.method === 'GET') {
        payload = { success: true, result: dnsRecords };
      } else if (p.includes('/dns_records') && options.method === 'POST') {
        const rec = { id: 'rec' + (dnsRecords.length + 1), ...body };
        dnsRecords = [...dnsRecords, rec];
        payload = { success: true, result: rec };
      } else if (p.startsWith('/client/v4/zones')) {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: [{ id: ZONE_ID, name }] };
      } else if (p.includes('/pages/projects/') && p.endsWith('/domains')) {
        payload =
          options.method === 'GET'
            ? { success: true, result: [{ name: 'berks-fixture.com', status: 'active' }] }
            : { success: true, result: { name: body && body.name, status: 'pending' } };
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

const engine = require(path.join(root, 'src/websiteEngine.js'));
const cfDomains = require(path.join(root, 'src/cfDomains.js'));

/* ---------------- fixtures ---------------- */
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const DOMAIN = 'berks-fixture.com';
const DOMAIN_BASE = `https://${DOMAIN}`;
const PROJECT = 'bp-w1-s21';
const DEPLOY_HOST = 'eacb2819.bp-w1-s21.pages.dev';
const DEPLOY_URL = `https://${DEPLOY_HOST}`;
const PROJECT_BASE = `https://${PROJECT}.pages.dev`;

const PAGES = [
  {
    slug: '/',
    title: 'Fixture Roll-Off Co — Dumpster Rental in Reading, PA',
    description: 'Fixture Roll-Off Co offers dumpster rental across Berks County.',
    sections: [
      { type: 'nav', content: {} },
      { type: 'html', content: { html: '<h1>Dumpster Rental in Reading, PA</h1><p>Roll-off containers, same-week delivery.</p>' } },
      { type: 'footer', content: { business_name: 'Fixture Roll-Off Co' } },
    ],
  },
  {
    slug: 'services/dumpster-rental',
    title: 'Dumpster Rental Services',
    description: 'Sizes and pricing for roll-off dumpster rental.',
    sections: [
      { type: 'nav', content: {} },
      { type: 'html', content: { html: '<h1>Dumpster Rental Services</h1><p>10, 20 and 30 yard containers.</p>' } },
      { type: 'footer', content: { business_name: 'Fixture Roll-Off Co' } },
    ],
  },
];

function makeDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  engine.ensureTables(db);
  cfDomains.ensureTables(db);
  try {
    require(path.join(root, 'server/siteModules.js')).ensureTables(db);
  } catch {
    /* optional */
  }
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('cf.api_token', 'fixture-token-not-a-real-secret');
  put.run('cf.account_id', ACCOUNT_ID);
  return db;
}

function addSite(db, id, { previewUrl, customDomain = null }) {
  db.prepare(
    `INSERT INTO leads (id, business_name, category, phone, email, city, state, address, postal_code, country)
     VALUES (?, 'Fixture Roll-Off Co', 'Dumpster rental', '(610) 555-0142', 'hello@fixture.example', 'Reading', 'PA', '12 Main St', '19601', 'US')`
  ).run(id);
  db.prepare(
    `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, custom_domain, updated_at)
     VALUES (?, ?, 'Fixture Roll-Off Co', 'dumpster rental', '{}', ?, 'draft', ?, ?, '2026-10-01 00:00:00')`
  ).run(id, id, JSON.stringify(PAGES), previewUrl, customDomain);
}

function assertExportOnBase(dir, base, label) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(
    html.includes(`<link rel="canonical" href="${base}/">`),
    `${label}: canonical must be on ${base}/ — got: ${(html.match(/<link rel="canonical"[^>]*>/) || ['(none)'])[0]}`
  );
  const sitemap = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 2, `${label}: sitemap has ${locs.length} locs`);
  for (const loc of locs) {
    assert.ok(loc.startsWith(base), `${label}: sitemap loc off-base: ${loc}`);
  }
  const robots = fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8');
  assert.ok(robots.includes(`Sitemap: ${base}/sitemap.xml`), `${label}: robots Sitemap line must be on ${base}: ${robots.trim()}`);
  return { html, sitemap, robots };
}

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
  /* ---------- 1: link-with-publish bakes the linked domain ---------- */
  await checkAsync('link-with-publish: publishFn receives the seoBaseUrl override; export canonical/sitemap/robots all on the linked domain', async () => {
    dnsRecords = [];
    httpCalls.length = 0;
    const db = makeDb();
    addSite(db, 4101, { previewUrl: DEPLOY_URL });
    // Pre-link derivation is the stale per-deployment host (collapsed) —
    // exactly why the override matters.
    assert.equal(engine.buildSeoExportContext(db, 4101).baseUrl, PROJECT_BASE, 'pre-link base is the collapsed preview host');
    assert.equal(
      engine.buildSeoExportContext(db, 4101, { seoBaseUrl: DOMAIN_BASE }).baseUrl,
      DOMAIN_BASE,
      'explicit override wins over derivation'
    );

    const outDir = path.join(process.env.EXPORT_ROOT, 'link-publish-4101');
    let seenCtx = null;
    let seenArgs = null;
    const r = await cfDomains.linkDomainToWebsite(db, {
      domain: DOMAIN,
      websiteId: 4101,
      leadId: 4101,
      project: PROJECT,
      workspaceId: 1,
      forcePublish: true,
      publishFn: async (websiteId, project, linkCtx) => {
        seenArgs = { websiteId, project };
        seenCtx = linkCtx;
        // The IPC/MCP funnel shape: exportStatic threads the override.
        engine.exportStatic(db, websiteId, outDir, { seoBaseUrl: linkCtx && linkCtx.seoBaseUrl });
      },
    });
    assert.deepEqual(seenArgs, { websiteId: 4101, project: PROJECT });
    assert.ok(seenCtx && seenCtx.seoBaseUrl === DOMAIN_BASE, `publishFn must receive the linked domain as seoBaseUrl, got ${JSON.stringify(seenCtx)}`);
    const linked = assertExportOnBase(outDir, DOMAIN_BASE, 'link-with-publish');
    assert.ok(!linked.sitemap.includes('pages.dev') && !linked.robots.includes('pages.dev'), 'no artifact may reference pages.dev once a custom domain is the base');
    // Stored state written by the link itself is untouched behavior.
    assert.equal(r.publicUrl, DOMAIN_BASE);
    const site = db.prepare('SELECT custom_domain FROM websites WHERE id = 4101').get();
    assert.equal(site.custom_domain, DOMAIN);
    const row = db.prepare('SELECT status FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.equal(row.status, 'linked');
    db.close();
  });

  /* ---------- 2: plain republish with custom_domain keeps domain base ---------- */
  check('plain export: site WITH custom_domain set keeps the domain base (pinned existing behavior)', () => {
    const db = makeDb();
    addSite(db, 4102, { previewUrl: 'https://already-linked.example', customDomain: 'already-linked.example' });
    assert.equal(engine.buildSeoExportContext(db, 4102).baseUrl, 'https://already-linked.example');
    const dir = path.join(process.env.EXPORT_ROOT, 'plain-4102');
    engine.exportStatic(db, 4102, dir);
    const plain = assertExportOnBase(dir, 'https://already-linked.example', 'plain-with-domain');
    assert.ok(!plain.sitemap.includes('pages.dev'), 'domain-based sitemap must not reference pages.dev');
    db.close();
  });

  /* ---------- 3: per-deployment preview_url collapses to the project host ---------- */
  check('hardening: only a per-deployment preview_url → base collapses to the stable project subdomain', () => {
    const db = makeDb();
    addSite(db, 4103, { previewUrl: DEPLOY_URL });
    assert.equal(engine.buildSeoExportContext(db, 4103).baseUrl, PROJECT_BASE, 'deployment host collapses');
    const dir = path.join(process.env.EXPORT_ROOT, 'plain-4103');
    engine.exportStatic(db, 4103, dir);
    const { html, sitemap, robots } = assertExportOnBase(dir, PROJECT_BASE, 'collapsed-preview');
    assert.ok(!html.includes(DEPLOY_HOST), 'canonical host is not the deployment hash host');
    assert.ok(!sitemap.includes(DEPLOY_HOST) && !robots.includes(DEPLOY_HOST), 'no artifact references the deployment host');
    // A stable project host is NOT collapsed further.
    addSite(db, 4104, { previewUrl: 'https://bp-w1-s9.pages.dev' });
    assert.equal(engine.buildSeoExportContext(db, 4104).baseUrl, 'https://bp-w1-s9.pages.dev', 'stable project host untouched');
    // A non-pages.dev preview host is untouched.
    addSite(db, 4105, { previewUrl: 'https://preview.example.com' });
    assert.equal(engine.buildSeoExportContext(db, 4105).baseUrl, 'https://preview.example.com', 'custom preview host untouched');
    db.close();
  });

  /* ---------- 4: failed publish during link leaves no domain claim ---------- */
  await checkAsync('failed publish during link: override was passed for that export only; stored state unchanged, no leak into later derivation', async () => {
    dnsRecords = [];
    httpCalls.length = 0;
    const db = makeDb();
    addSite(db, 4106, { previewUrl: DEPLOY_URL });
    let seenCtx = null;
    await assert.rejects(
      () =>
        cfDomains.linkDomainToWebsite(db, {
          domain: DOMAIN,
          websiteId: 4106,
          leadId: 4106,
          project: PROJECT,
          workspaceId: 1,
          forcePublish: true,
          publishFn: async (websiteId, project, linkCtx) => {
            seenCtx = linkCtx;
            throw new Error('publish boom (fixture)');
          },
        }),
      /publish boom/
    );
    assert.ok(seenCtx && seenCtx.seoBaseUrl === DOMAIN_BASE, 'the failed export still received the override');
    const site = db.prepare('SELECT custom_domain FROM websites WHERE id = 4106').get();
    assert.ok(!site.custom_domain, 'custom_domain stays unset after a failed publish');
    const row = db.prepare('SELECT * FROM site_domains WHERE domain_name = ?').get(DOMAIN);
    assert.ok(!row || row.status !== 'linked', 'no linked site_domains row after a failed publish');
    assert.equal(
      engine.buildSeoExportContext(db, 4106).baseUrl,
      PROJECT_BASE,
      'override does not leak: a later export derives the collapsed preview base, not the domain'
    );
    db.close();
  });

  /* ---------- 5: structural wiring of every publish funnel ---------- */
  check('funnels: domainsLink + domainFlowComplete thread linkCtx into materialize; materialize forwards opts.seoBaseUrl; domainFlow forwards; IPC/MCP export funnels thread it', () => {
    const domainSrc = fs.readFileSync(path.join(root, 'server/domain.js'), 'utf8');
    assert.ok(
      domainSrc.includes('buildSeoExportContext(db, siteId, { seoBaseUrl: opts.seoBaseUrl })'),
      'materializeWebsiteExport forwards opts.seoBaseUrl into buildSeoExportContext'
    );
    const threadCount = (domainSrc.match(/seoBaseUrl: linkCtx && linkCtx\.seoBaseUrl/g) || []).length;
    assert.ok(threadCount >= 2, `domainsLink + domainFlowComplete both thread linkCtx (found ${threadCount})`);
    assert.ok(domainSrc.includes('publishFn: async (websiteId, project, linkCtx)'), 'domainsLink publishFn takes the link context');
    assert.ok(domainSrc.includes('publishSite: async (db2, websiteId, project, linkCtx)'), 'domainFlowComplete publishSite takes the link context');
    const flowSrc = fs.readFileSync(path.join(root, 'server/domainFlow.js'), 'utf8');
    assert.ok(
      flowSrc.includes('deps.publishSite(db, websiteId, project, linkCtx)'),
      'domainFlow forwards the link context to the injected publishSite'
    );
    const ipcSrc = fs.readFileSync(path.join(root, 'src/ipc/domains.js'), 'utf8');
    assert.ok(ipcSrc.includes('seoBaseUrl: linkCtx && linkCtx.seoBaseUrl'), 'IPC domains:link funnel threads the override into exportStatic');
    const mcpSrc = fs.readFileSync(path.join(root, 'src/mcpParityTools.js'), 'utf8');
    assert.ok(mcpSrc.includes('seoBaseUrl: linkCtx && linkCtx.seoBaseUrl'), 'MCP domains.link funnel threads the override into exportStatic');
  });

  httpsPatch.restore();
  console.log(JSON.stringify({ file: 'seo-base-url-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'seo-base-url-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
