'use strict';
/**
 * Batch 102 — security shut-downs (Ely-ordered security fixes,
 * 2026-10-31; fix log ~/workspace/website-scout/security-fix-log-2026-10-31.md):
 *   SEC-01  design-agent shell trigger DELETED (spawn path gone; the
 *           trigger-command + webhook-url keys are no longer settable
 *           via the settings API — webhook URL is staff-only now).
 *   SEC-14  cf.account_id seed default removed (was Ely's account id).
 *   SEC-05  domain registration requires the workspace's OWN CF token
 *           (platform fallback = previews/publish only), fail-fast.
 *   SEC-02  the guided flow's price cap (default $25) enforced at the
 *           registerDomain choke point every registration path shares.
 *   SEC-18  partner purchase gate covers TOKEN-authenticated REST
 *           (gatePurchaseForRequest -> workspace gate for tokens).
 *   SEC-11  MCP calls.poolAdd joins the partner purchase gate (pin).
 *   SEC-19  permanent purge tears down Cloudflare (detach + DNS +
 *           own-project delete; shared projects never deleted).
 *   SEC-20  uploadAsset content validation (magic bytes; script-free
 *           SVG) + workspace-scoped staging folders.
 *   SEC-03  platform-defaults snapshot carries NO secret values and
 *           is written mode 600.
 *   SEC-12  /api/v1/openapi.json is staff-gated (source pin).
 *
 * NEGATIVE PROOFS: B102_NEGATIVE=trigger re-adds the trigger-command
 * key to SETTABLE_KEYS (VM shim) -> Part 1 goes RED. B102_NEGATIVE=cap
 * shims the cap comparison out of cfDomains (VM load) -> Part 3's
 * over-cap assertions go RED.
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b102-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch102', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 17).toString('base64');

const NEGATIVE = process.env.B102_NEGATIVE || '';
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

/* ---------------- CF HTTP stub (before cfDomains loads) ---------------- */
const httpCalls = [];
let stubPrice = 10.46;
let stubPriced = true;
let dnsRecords = [];
const ZONE_ID = 'zone102fixture00000000000000abcd';
{
  const https = require('node:https');
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
      let payload = { success: true, result: {} };
      const p = options.path;
      if (p.includes('/registrar/domain-check')) {
        const names = (body && body.domains) || [];
        payload = {
          success: true,
          result: {
            domains: names.map((name) => ({
              name,
              registrable: true,
              pricing: stubPriced ? { currency: 'USD', registration_cost: stubPrice, renewal_cost: stubPrice } : {},
            })),
          },
        };
      } else if (p.includes('/registrar/registrations') && options.method === 'POST') {
        payload = { success: true, result: { state: 'succeeded', completed: true } };
      } else if (p.startsWith('/client/v4/zones?')) {
        const name = new URLSearchParams(p.split('?')[1] || '').get('name');
        payload = { success: true, result: [{ id: ZONE_ID, name }] };
      } else if (p.includes('/dns_records') && options.method === 'GET') {
        payload = { success: true, result: dnsRecords };
      } else if (p.includes('/dns_records/') && options.method === 'DELETE') {
        payload = { success: true, result: {} };
      } else if (p.includes('/pages/projects/') && options.method === 'DELETE') {
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

function loadSettingsKeys() {
  let src = fs.readFileSync(path.join(root, 'server', 'settingsKeys.js'), 'utf8');
  if (NEGATIVE === 'trigger') {
    const shimmed = src.replace(
      "  'design.agent_notify',\n",
      "  'design.agent_notify',\n  'design.agent_trigger_command',\n"
    );
    assert.notEqual(shimmed, src, 'trigger shim must change the settingsKeys source');
    src = shimmed;
  }
  const m = { exports: {} };
  vm.runInNewContext(src + ';module.exports = module.exports;', {
    module: m,
    exports: m.exports,
    console,
    Buffer,
    process,
  });
  return m.exports;
}

function loadCfDomains() {
  if (NEGATIVE !== 'cap') return require(path.join(root, 'src', 'cfDomains.js'));
  let src = fs.readFileSync(path.join(root, 'src', 'cfDomains.js'), 'utf8');
  const shimmed = src.replace('priceCents > capCents', 'false /* B102 NEGATIVE SHIM */');
  assert.notEqual(shimmed, src, 'cap shim must change the cfDomains source');
  const m = { exports: {} };
  const localRequire = require('node:module').createRequire(path.join(root, 'src', 'cfDomains.js'));
  vm.runInNewContext(src + ';module.exports = module.exports;', {
    module: m,
    exports: m.exports,
    require: localRequire,
    console,
    Buffer,
    process,
    __dirname: path.join(root, 'src'),
    __filename: path.join(root, 'src', 'cfDomains.js'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
  });
  return m.exports;
}

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
function makeCfDb({ withCreds = true, project = '' } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (withCreds) {
    put.run('cf.api_token', 'fixture-token-not-a-real-secret');
    put.run('cf.account_id', ACCOUNT_ID);
  }
  if (project) put.run('cf.project', project);
  const reg = {
    'domain.registrant_first_name': 'Fixture',
    'domain.registrant_last_name': 'Owner',
    'domain.registrant_email': 'owner@fixture.test',
    'domain.registrant_phone': '+1 610 555 0123',
    'domain.registrant_address': '1 Main St',
    'domain.registrant_city': 'Reading',
    'domain.registrant_state': 'PA',
    'domain.registrant_postal_code': '19601',
    'domain.registrant_country': 'US',
  };
  for (const [k, v] of Object.entries(reg)) put.run(k, v);
  return db;
}

(async () => {
  /* ---------- Part 1: SEC-01 trigger deletion + staff-only webhook --- */
  {
    let n = 0;
    const keys = loadSettingsKeys();
    assert.equal(keys.SETTABLE_KEYS.includes('design.agent_trigger_command'), false);
    n++;
    assert.equal(keys.SETTABLE_KEYS.includes('design.agent_webhook_url'), false);
    n++;
    assert.equal(keys.validateSetting('design.agent_trigger_command', 'echo hi').ok, false);
    n++;
    assert.equal(keys.validateSetting('design.agent_webhook_url', 'https://example.com/hook').ok, false);
    n++;
    const triggerSrc = fs.readFileSync(path.join(root, 'src', 'designAgentTrigger.js'), 'utf8');
    assert.equal(/spawn\s*\(/.test(triggerSrc), false, 'no spawn() may remain in designAgentTrigger');
    n++;
    assert.equal(triggerSrc.includes('shell: true') || triggerSrc.includes('shell:true'), false);
    n++;
    assert.equal(triggerSrc.includes("getSetting(db, 'design.agent_trigger_command'"), false);
    n++;
    const trigger = require(path.join(root, 'src', 'designAgentTrigger.js'));
    const db = new Database(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('design.agent_trigger_command', 'echo PWNED');
    const status = trigger.agentTriggerStatus(db);
    assert.equal(status.commandConfigured, false, 'a stored legacy command reports as unconfigured — it can never run');
    n++;
    group('SEC-01 shell trigger deleted + webhook staff-only', n);
  }

  /* ---------- Part 2: SEC-14 seed ------------------------------------ */
  {
    let n = 0;
    const keys = loadSettingsKeys();
    const seed = keys.SETTING_SEEDS.find(([k]) => k === 'cf.account_id');
    assert.ok(seed, 'cf.account_id seed row still exists');
    n++;
    assert.equal(seed[1], '', 'cf.account_id seeds EMPTY (no hardcoded platform account)');
    n++;
    group('SEC-14 cf.account_id seed removed', n);
  }

  await require(path.join(root, 'server', 'db.js')).migrate();
  const platform = require(path.join(root, 'server', 'platform.js'));
  const cfDomains = loadCfDomains();

  /* ---------- Part 3: SEC-05 own-token + SEC-02 cap ------------------- */
  {
    let n = 0;
    // Platform fallback configured, workspace has NO creds of its own.
    await platform.setPlatformSetting('cf.api_token', 'platform-fixture-token');
    await platform.setPlatformSetting('cf.account_id', ACCOUNT_ID);
    const dbNoCreds = makeCfDb({ withCreds: false });
    cfDomains.ensureTables(dbNoCreds);
    httpCalls.length = 0;
    await assert.rejects(
      () => cfDomains.registerDomain(dbNoCreds, 'cheap-fixture.com', {}),
      (e) => e && e.code === 'CF_WORKSPACE_TOKEN_REQUIRED'
    );
    n++;
    assert.equal(
      httpCalls.filter((c) => c.path.includes('/registrar/')).length,
      0,
      'own-token refusal happens before ANY registrar call'
    );
    n++;

    // Workspace creds + in-cap price -> registers.
    const dbOk = makeCfDb();
    cfDomains.ensureTables(dbOk);
    stubPrice = 10.46;
    stubPriced = true;
    httpCalls.length = 0;
    const okOut = await cfDomains.registerDomain(dbOk, 'cheap-fixture.com', {});
    assert.ok(okOut && okOut.domain === 'cheap-fixture.com');
    n++;
    assert.equal(httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/registrar/registrations')).length, 1);
    n++;

    // Over-cap price -> refused, no registration POST.
    stubPrice = 30.0;
    httpCalls.length = 0;
    await assert.rejects(
      () => cfDomains.registerDomain(dbOk, 'pricey-fixture.com', {}),
      (e) => e && e.code === 'DOMAIN_OVER_CAP'
    );
    n++;
    assert.equal(httpCalls.filter((c) => c.method === 'POST' && c.path.includes('/registrar/registrations')).length, 0);
    n++;

    // Unpriced -> refused (price cannot be verified under the cap).
    stubPriced = false;
    await assert.rejects(
      () => cfDomains.registerDomain(dbOk, 'unpriced-fixture.com', {}),
      (e) => e && e.code === 'DOMAIN_OVER_CAP'
    );
    n++;
    group('SEC-05 own-token + SEC-02 price cap at registerDomain', n);
  }

  /* ---------- Part 4: SEC-19 purge teardown --------------------------- */
  {
    let n = 0;
    const db = makeCfDb();
    cfDomains.ensureTables(db);
    db.exec('CREATE TABLE IF NOT EXISTS websites (id INTEGER PRIMARY KEY, name TEXT);');
    db.prepare('INSERT INTO websites (id, name) VALUES (1, ?)').run('Fixture Site');
    db.prepare(
      "INSERT INTO site_domains (website_id, lead_id, domain_name, status, source) VALUES (1, NULL, 'fixture-site.com', 'linked', 'link')"
    ).run();
    dnsRecords = [
      { id: 'rec-mine', name: 'fixture-site.com', type: 'CNAME', content: 'bp-w1-s1.pages.dev' },
      { id: 'rec-other', name: 'fixture-site.com', type: 'CNAME', content: 'someone-else.pages.dev' },
      { id: 'rec-a', name: 'fixture-site.com', type: 'A', content: '192.0.2.10' },
    ];
    httpCalls.length = 0;
    const out = await cfDomains.teardownWebsiteCloudflare(db, { websiteId: 1, workspaceId: 1 });
    assert.equal(out.project, 'bp-w1-s1');
    n++;
    assert.equal(out.projectDeleted, true, "the site's own auto project is deleted");
    n++;
    assert.equal(out.dnsRemoved, 1, 'only the CNAME pointing at this project is removed');
    n++;
    assert.equal(out.domains.length, 1);
    n++;
    assert.equal(out.domains[0].detached, true);
    n++;
    assert.deepEqual(out.errors, []);
    n++;
    const dnsDeletes = httpCalls.filter((c) => c.method === 'DELETE' && c.path.includes('/dns_records/'));
    assert.equal(dnsDeletes.length, 1);
    n++;
    assert.ok(dnsDeletes[0].path.includes('rec-mine'), 'the deleted record is ours, never a foreign one');
    n++;

    // Shared/custom project: detach + DNS still happen, project survives.
    const dbShared = makeCfDb({ project: 'shared-proj' });
    cfDomains.ensureTables(dbShared);
    dbShared.prepare(
      "INSERT INTO site_domains (website_id, lead_id, domain_name, status, source) VALUES (1, NULL, 'fixture-site.com', 'linked', 'link')"
    ).run();
    dnsRecords = [{ id: 'rec-mine2', name: 'fixture-site.com', type: 'CNAME', content: 'shared-proj.pages.dev' }];
    httpCalls.length = 0;
    const out2 = await cfDomains.teardownWebsiteCloudflare(dbShared, { websiteId: 1, workspaceId: 1 });
    assert.equal(out2.project, 'shared-proj');
    n++;
    assert.equal(out2.projectDeleted, false, 'a shared project is never deleted');
    n++;
    assert.equal(
      httpCalls.filter((c) => c.method === 'DELETE' && /\/pages\/projects\/[^/]+$/.test(c.path)).length,
      0,
      'no project DELETE call for a shared project'
    );
    n++;
    group('SEC-19 purge Cloudflare teardown', n);
  }

  /* ---------- Part 5: SEC-20 asset validation + scoped folders -------- */
  {
    let n = 0;
    const av = require(path.join(root, 'src', 'assetValidation.js'));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
    assert.equal(av.validateAssetBuffer('logo.png', png).ok, true);
    n++;
    assert.equal(av.validateAssetBuffer('logo.png', Buffer.from('<html><script>alert(1)</script></html>')).ok, false);
    n++;
    assert.equal(av.validateAssetBuffer('photo.png', Buffer.from([0xff, 0xd8, 0xff, 0xe0]).length ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]) : png).ok, false, 'jpeg bytes under .png are rejected');
    n++;
    const cleanSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    assert.equal(av.validateAssetBuffer('mark.svg', cleanSvg).ok, true);
    n++;
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(av.validateAssetBuffer('mark.svg', evilSvg).ok, false);
    n++;
    const handlerSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    assert.equal(av.validateAssetBuffer('mark.svg', handlerSvg).ok, false);
    n++;
    const woff2 = Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(32, 1)]);
    assert.equal(av.validateAssetBuffer('font.woff2', woff2).ok, true);
    n++;
    assert.equal(av.validateAssetBuffer('font.woff2', png).ok, false);
    n++;
    assert.equal(av.siteStorageFolder(2, 1), 'ws-2-site-1');
    n++;
    assert.deepEqual(av.siteStorageFolders(2, 1), ['ws-2-site-1', 'site-1']);
    n++;
    assert.equal(av.siteStorageFolder(null, 5), 'site-5');
    n++;
    group('SEC-20 asset validation + scoped staging folders', n);
  }

  /* ---------- Part 6: SEC-18 partner gate for token callers ----------- */
  {
    let n = 0;
    const { query } = require(path.join(root, 'server', 'db.js'));
    const workspaceMod = require(path.join(root, 'server', 'workspace.js'));
    const partners = require(path.join(root, 'server', 'partners.js'));
    // Partners are created the only way they can be: by an admin, with
    // the account type set at creation (batch80 fixture pattern).
    const admin = require(path.join(root, 'server', 'admin.js'));
    const createdRaw = await admin.createUser({
      email: 'partner102@fixture.test',
      password: 'fixture-password-102',
      name: 'Partner Fixture',
      workspaceName: 'Partner Fixture WS',
      accountType: 'partner',
    });
    const created = { userId: Number(createdRaw.userId), workspaceId: Number(createdRaw.workspaceId) };
    assert.ok(await partners.isPartnerUser(created.userId), 'fixture user is a partner');

    // Session caller (Batch 80 behaviour preserved).
    const g1 = await partners.gatePurchaseForRequest({
      auth: { via: 'session', userId: created.userId },
      workspaceId: created.workspaceId,
      actionKind: 'domain_register',
      payload: { domain: 'x.com' },
    });
    assert.ok(g1 && g1.approvalRequired === true, 'partner session call is gated');
    n++;
    // Token caller: the Audit 2 bypass — must now gate on the workspace.
    const g2 = await partners.gatePurchaseForRequest({
      auth: { via: 'token' },
      workspaceId: created.workspaceId,
      actionKind: 'domain_register',
      payload: { domain: 'x.com' },
    });
    assert.ok(g2 && g2.approvalRequired === true, 'partner TOKEN call is gated (SEC-18)');
    n++;
    // Non-partner workspace: no gate on either surface.
    const plainRaw = await workspaceMod.createUserWithWorkspace({
      email: 'plain102@fixture.test',
      password: 'fixture-password-102',
      name: 'Plain Fixture',
      workspaceName: 'Plain Fixture WS',
    });
    const plain = { userId: Number(plainRaw.userId), workspaceId: Number(plainRaw.workspaceId) };
    const g3 = await partners.gatePurchaseForRequest({
      auth: { via: 'token' },
      workspaceId: plain.workspaceId,
      actionKind: 'domain_register',
      payload: { domain: 'x.com' },
    });
    assert.equal(g3, null, 'non-partner token call proceeds');
    n++;
    group('SEC-18 partner gate covers token-authenticated REST', n);
  }

  /* ---------- Part 7: SEC-03 snapshot hygiene -------------------------- */
  {
    let n = 0;
    await platform.setPlatformSetting('stripe.secret_key', 'sk_test_FIXTURE102_do_not_leak');
    await platform.setPlatformSetting('app.name', 'FixturePype');
    const snap = await platform.savePlatformDefaultsSnapshot();
    const raw = fs.readFileSync(snap.path, 'utf8');
    assert.equal(raw.includes('FIXTURE102_do_not_leak'), false, 'no secret value in the snapshot');
    n++;
    const parsed = JSON.parse(raw);
    assert.equal(parsed['stripe.secret_key'], '', 'secret keys persist as empty markers');
    n++;
    assert.equal(parsed['app.name'], 'FixturePype', 'non-secret defaults still snapshot');
    n++;
    const mode = fs.statSync(snap.path).mode & 0o777;
    assert.equal(mode, 0o600, `snapshot mode is 600 (got ${mode.toString(8)})`);
    n++;
    // The backup-recipe exclusion (make-release-backup.sh no longer
    // copies platform-defaults.json into tars) is verified host-side
    // by the Batch 102 finisher: recipe sha pin + a tar-listing grep
    // on both the pre and post backups. The recipe is an ops script,
    // not part of the app tree, so it cannot be read from the gate.
    group('SEC-03 snapshot redaction + mode 600', n);
  }

  /* ---------- Part 8: SEC-11 + SEC-12 source pins ---------------------- */
  {
    let n = 0;
    const mcpSrc = fs.readFileSync(path.join(root, 'server', 'mcp.js'), 'utf8');
    // Anchor on the dispatch-level SEC-11 gate block (the first
    // 'calls.poolAdd' occurrence in the file is the tool handler).
    const poolGate = mcpSrc.indexOf('SEC-11');
    assert.ok(poolGate > 0, 'MCP dispatch carries the SEC-11 gate block');
    n++;
    const gateBlock = mcpSrc.slice(poolGate, poolGate + 600);
    assert.ok(
      gateBlock.includes("name === 'calls.poolAdd'") &&
        gateBlock.includes('gatePurchaseForWorkspace') &&
        gateBlock.includes('call_number_purchase'),
      'poolAdd gate uses the workspace gate with the call_number_purchase kind'
    );
    n++;
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(
      serverSrc.includes("app.get('/api/v1/openapi.json', requireSuperAdmin"),
      'openapi.json is staff-gated'
    );
    n++;
    group('SEC-11 MCP poolAdd gate + SEC-12 openapi staff gate (pins)', n);
  }

  console.log(JSON.stringify({ suite: 'batch102-security-regressions', groups, passed: true }));
})().catch((e) => {
  console.error('BATCH102 SUITE FAIL:', e);
  process.exit(1);
});
