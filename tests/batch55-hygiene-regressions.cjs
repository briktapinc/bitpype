'use strict';
/**
 * Batch 55 — hygiene batch regressions:
 *   A. SMTP require-TLS (review C-2): credentials never cross an
 *      unencrypted wire under the default posture; STARTTLS is used
 *      when offered; implicit TLS unaffected; smtp.require_tls='0' is a
 *      deliberate opt-out that keeps legacy behaviour + logs a warning.
 *      Wire facts come from stub SMTP servers run by a child fixture
 *      (tests/fixtures/batch55-smtp-child.cjs) — including a
 *      B55_NEGATIVE=1 run that restores the pre-fix fall-through and
 *      MUST show the password on the wire, proving the gate matters.
 *   B. Rate limiter (review C-3): counters live in the platform DB and
 *      survive restarts (proven across two child processes), windows
 *      stay sliding, buckets stay isolated, a store outage falls back
 *      to per-request in-memory counting, and the misleading
 *      RATE_LIMIT_REDIS_URL "set but unused" line is gone.
 *   C. Fresh-install seed (review B-1): smtp.host seeds EMPTY so a new
 *      install gets the StubProvider (forgot-password answers in ms,
 *      not a >30s doomed connection); seeding never overwrites stored
 *      values; host-without-credentials is a named validation warning.
 *   D. Two-apps split (review C-1): the legacy Electron tree is under
 *      archive/legacy-electron/, the production require graph never
 *      resolves into it, and no root-level duplicate of a server//src/
 *      module name remains.
 *
 * Hermetic: temp SQLITE_PATH + workspace dir pinned BEFORE any server
 * module is required (the Batch 53 pattern).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch55-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.APP_URL = process.env.APP_URL || 'http://localhost';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok -', name);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.error('FAIL -', name, e);
  }
}

/* ---------------- A. SMTP config + selection (in-process) ---------------- */

const email = require(path.join(root, 'src/email.js'));
const { readSmtpConfig, getProvider, validateMailSettings, SmtpProvider, StubProvider } = email;

const WS1 = {
  'smtp.host': 'in-v3.mailjet.com',
  'smtp.port': '587',
  'smtp.secure': '0',
  'smtp.user': 'mj-user',
  'smtp.pass': 'mj-pass',
  'smtp.from_name': 'Bitpype',
  'smtp.from_email': 'team@bitpype.com',
};

async function smtpConfigSuite() {
  await check('A1: smtp.require_tls defaults ON; only explicit opt-out values disable it', () => {
    assert.equal(readSmtpConfig({}).requireTls, true);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': '1' }).requireTls, true);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': 'true' }).requireTls, true);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': 'banana' }).requireTls, true);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': '0' }).requireTls, false);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': 'false' }).requireTls, false);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': 'no' }).requireTls, false);
    assert.equal(readSmtpConfig({ 'smtp.require_tls': 'off' }).requireTls, false);
  });

  await check('A2: ws1-shaped settings still select SmtpProvider, requireTls on, validation clean', () => {
    const p = getProvider({ ...WS1 });
    assert.ok(p instanceof SmtpProvider);
    assert.equal(p.cfg.requireTls, true);
    assert.equal(p.cfg.host, 'in-v3.mailjet.com');
    assert.deepEqual(validateMailSettings({ ...WS1 }), []);
  });
}

/* ---------------- A. SMTP wire behaviour (child fixture) ---------------- */

function genCerts(dir) {
  const run = (args) => {
    const r = spawnSync('openssl', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, `openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
  };
  run([
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'ca.key'),
    '-out', path.join(dir, 'ca.crt'), '-days', '3', '-nodes', '-subj', '/CN=Batch55-Test-CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run([
    'req', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'server.key'),
    '-out', path.join(dir, 'server.csr'), '-nodes', '-subj', '/CN=localhost',
  ]);
  fs.writeFileSync(
    path.join(dir, 'server-ext.cnf'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
  );
  run([
    'x509', '-req', '-in', path.join(dir, 'server.csr'),
    '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial',
    '-out', path.join(dir, 'server.crt'), '-days', '3',
    '-extfile', path.join(dir, 'server-ext.cnf'),
  ]);
}

function runSmtpChild(certDir, extraEnv) {
  const r = spawnSync(process.execPath, [path.join(root, 'tests/fixtures/batch55-smtp-child.cjs')], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: path.join(certDir, 'ca.crt'),
      B55_CERT_KEY: path.join(certDir, 'server.key'),
      B55_CERT_CRT: path.join(certDir, 'server.crt'),
      ...extraEnv,
    },
  });
  assert.equal(r.status, 0, `smtp child exited ${r.status}: ${r.stderr}`);
  const lines = String(r.stdout).trim().split('\n');
  const facts = JSON.parse(lines[lines.length - 1]);
  assert.ok(!facts.fatal, `smtp child fatal: ${facts.fatal}`);
  return facts;
}

async function smtpWireSuite() {
  const certDir = path.join(temp, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  genCerts(certDir);

  // Normal run INHERITS the ambient env on purpose: running this whole
  // file with B55_NEGATIVE=1 must turn A4 red (the manual negative
  // proof). A7 below spawns the shim explicitly and stays green either
  // way, so the leak is pinned in every suite run.
  const facts = runSmtpChild(certDir, {});
  await check('A3: STARTTLS offered -> send succeeds, credentials only ever on the encrypted leg', () => {
    const s = facts.S1_starttls;
    assert.equal(s.sent, true, JSON.stringify(s));
    assert.equal(s.stub.completed, true);
    assert.equal(s.stub.credentialLines, 2, 'user+pass both received (encrypted)');
    assert.equal(s.stub.plaintextCredentialLines, 0, 'no credential bytes in plaintext');
    assert.equal(s.stub.plaintextAuthAttempts, 0, 'no AUTH attempted before the upgrade');
  });

  await check('A4: no encryption offered -> SMTP_TLS_REQUIRED refusal, zero credential bytes on the wire', () => {
    const s = facts.S2_noEncryption;
    assert.equal(s.sent, false);
    assert.equal(s.errorCode, 'SMTP_TLS_REQUIRED');
    assert.match(s.errorMessage, /no password was sent/);
    assert.equal(s.stub.authAttempts, 0);
    assert.equal(s.stub.credentialLines, 0);
    assert.equal(s.stub.completed, false);
  });

  await check('A5: implicit TLS (465-style) sends exactly as before', () => {
    const s = facts.S3_implicitTls;
    assert.equal(s.sent, true, JSON.stringify(s));
    assert.equal(s.stub.completed, true);
    assert.equal(s.stub.plaintextCredentialLines, 0);
  });

  await check("A6: smtp.require_tls='0' opt-out keeps legacy plaintext send AND logs the warning", () => {
    const s = facts.S4_optOut;
    assert.equal(s.sent, true, JSON.stringify(s));
    assert.equal(s.stub.completed, true);
    assert.equal(s.stub.plaintextCredentialLines, 2, 'legacy behaviour: credentials do cross in plaintext when opted out');
    assert.ok(
      facts.warnings.some((w) => w.includes('UNENCRYPTED')),
      `expected an UNENCRYPTED warning, got: ${JSON.stringify(facts.warnings)}`
    );
  });

  const neg = runSmtpChild(certDir, { B55_NEGATIVE: '1' });
  await check('A7: NEGATIVE PROOF — with the TLS gate shimmed off, the password crosses in plaintext', () => {
    const s = neg.S2_noEncryption;
    assert.equal(s.sent, true, 'pre-fix fall-through sends the mail');
    assert.equal(s.stub.plaintextCredentialLines, 2, 'pre-fix fall-through leaks both credential lines');
    assert.equal(s.stub.plaintextAuthAttempts, 1);
  });
}

/* ---------------- B. Rate limiter ---------------- */

const rateLimitMod = require(path.join(root, 'server/rateLimit.js'));
const rateLimitStore = require(path.join(root, 'server/rateLimitStore.js'));

async function hit(mw, ip) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) {
        this.code = c;
        return this;
      },
      json() {
        resolve(this.code);
        return this;
      },
    };
    Promise.resolve(mw({ ip }, res, () => resolve(200))).catch(() => resolve(500));
  });
}

async function limiterSuite() {
  await check('B1: store sliding window — count rises per hit and old hits fall out of the window', async () => {
    await rateLimitStore.clearBucket('b55-unit');
    const t0 = 1_000_000_000;
    assert.equal(await rateLimitStore.recordHit('b55-unit', 'k1', 1000, t0), 1);
    assert.equal(await rateLimitStore.recordHit('b55-unit', 'k1', 1000, t0 + 100), 2);
    assert.equal(await rateLimitStore.recordHit('b55-unit', 'k1', 1000, t0 + 200), 3);
    // 1.5s later the window (t0+500, t0+1500] holds only the new hit.
    assert.equal(await rateLimitStore.recordHit('b55-unit', 'k1', 1000, t0 + 1500), 1);
    // A different key in the same bucket is independent.
    assert.equal(await rateLimitStore.recordHit('b55-unit', 'k2', 1000, t0 + 1500), 1);
  });

  await check('B2: a second limiter instance over the same store still sees the budget as spent', async () => {
    await rateLimitStore.clearBucket('b55-xinst');
    const a = rateLimitMod.rateLimit({ windowMs: 60000, max: 2, name: 'b55-xinst' });
    assert.equal(await hit(a, '198.51.100.7'), 200);
    assert.equal(await hit(a, '198.51.100.7'), 200);
    assert.equal(await hit(a, '198.51.100.7'), 429);
    // A fresh instance (what a restarted process constructs) shares NO
    // memory with `a` — only the store. Its first hit must already 429.
    const b = rateLimitMod.rateLimit({ windowMs: 60000, max: 2, name: 'b55-xinst' });
    assert.equal(await hit(b, '198.51.100.7'), 429);
    // Isolation: another bucket, same IP, is unaffected.
    const c = rateLimitMod.rateLimit({ windowMs: 60000, max: 2, name: 'b55-xinst-other' });
    assert.equal(await hit(c, '198.51.100.7'), 200);
  });

  await check('B3: budgets survive a full process restart (two child processes, one DB)', () => {
    const childEnv = {
      ...process.env,
      RL_NAME: 'b55-restart',
      RL_MAX: '3',
      RL_WINDOW_MS: '900000',
      RL_KEY: '203.0.113.55',
    };
    const runChild = (hits) => {
      const r = spawnSync(process.execPath, [path.join(root, 'tests/fixtures/batch55-ratelimit-child.cjs')], {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...childEnv, RL_HITS: String(hits) },
      });
      assert.equal(r.status, 0, `ratelimit child failed: ${r.stderr}`);
      return JSON.parse(String(r.stdout).trim().split('\n').pop());
    };
    assert.deepEqual(runChild(5), { allowed: 3, limited: 2 });
    // Fresh process, empty heap: the budget is STILL spent.
    assert.deepEqual(runChild(1), { allowed: 0, limited: 1 });
  });

  await check('B4: store outage falls back to per-request in-memory counting (never wide open)', async () => {
    rateLimitMod._setStoreForTests({
      recordHit: async () => {
        throw new Error('store down (test)');
      },
    });
    try {
      const mw = rateLimitMod.rateLimit({ windowMs: 60000, max: 2, name: 'b55-fallback' });
      assert.equal(await hit(mw, '192.0.2.9'), 200);
      assert.equal(await hit(mw, '192.0.2.9'), 200);
      assert.equal(await hit(mw, '192.0.2.9'), 429);
    } finally {
      rateLimitMod._setStoreForTests(null);
    }
  });

  await check('B5: bucket derivation — unnamed limiters are distinct per construction site; names pass through', () => {
    const d = rateLimitMod._deriveBucketForTests;
    const b1 = d('default', 900000, 40);
    const b2 = d('default', 900000, 40);
    assert.notEqual(b1, b2, 'two identical unnamed limiters must not share a bucket');
    assert.ok(b1.includes('batch55-hygiene-regressions'), `bucket names its construction site: ${b1}`);
    assert.equal(d('site-analytics', 60000, 240), 'site-analytics');
  });

  await check('B6: honesty pins — no "set but unused" trap, no Redis in the stack, store is the platform DB', () => {
    const rl = fs.readFileSync(path.join(root, 'server/rateLimit.js'), 'utf8');
    assert.ok(!rl.includes('RATE_LIMIT_REDIS_URL set but unused'), 'the misleading startup line must stay gone');
    assert.ok(rl.includes('does not use Redis'), 'startup line names the actual backend');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    assert.ok(!/redis/i.test(compose), 'compose has no Redis service (the fact the design rests on)');
    const store = fs.readFileSync(path.join(root, 'server/rateLimitStore.js'), 'utf8');
    assert.ok(store.includes("require('./db')"), 'store persists through the platform DB layer');
    assert.ok(store.includes('rate_limit_hits'), 'store writes the rate_limit_hits table');
  });
}

/* ---------------- C. Seeds + validation + forgot-password ---------------- */

const settingsKeys = require(path.join(root, 'server/settingsKeys.js'));
const platform = require(path.join(root, 'server/platform.js'));

async function seedSuite() {
  await check("C1: seeds — smtp.host defaults EMPTY, smtp.require_tls seeded '1' and workspace-seeded", () => {
    const seeds = new Map(settingsKeys.SETTING_SEEDS);
    assert.equal(seeds.get('smtp.host'), '');
    assert.equal(seeds.get('smtp.require_tls'), '1');
    const defs = new Map(platform.PLATFORM_SETTING_DEFS.map((d) => [d.key, d.default]));
    assert.equal(defs.get('smtp.host'), '');
    assert.equal(defs.get('smtp.require_tls'), '1');
    assert.ok(platform.WORKSPACE_SEED_KEYS.includes('smtp.require_tls'));
  });

  await check('C2: smtp.require_tls is settable and validated like the other booleans', () => {
    assert.ok(settingsKeys.SETTABLE_KEYS.includes('smtp.require_tls'));
    assert.deepEqual(settingsKeys.validateSetting('smtp.require_tls', '0'), { ok: true, value: '0' });
    assert.deepEqual(settingsKeys.validateSetting('smtp.require_tls', 'yes'), { ok: true, value: '1' });
    assert.equal(settingsKeys.validateSetting('smtp.require_tls', 'bogus').ok, false);
  });

  await check('C3: a freshly-seeded settings object selects the StubProvider (no live connection attempted)', () => {
    const fresh = Object.fromEntries(settingsKeys.SETTING_SEEDS);
    const p = getProvider(fresh);
    assert.ok(p instanceof StubProvider);
    assert.equal(p.name, 'stub');
    // And a stored, configured workspace is untouched by the new default:
    const configured = getProvider({ ...WS1 });
    assert.ok(configured instanceof SmtpProvider);
  });

  await check('C4: validateMailSettings names the host-without-credentials trap', () => {
    const errs = validateMailSettings({
      'smtp.host': 'in-v3.mailjet.com',
      'smtp.from_email': 'team@bitpype.com',
    });
    assert.ok(
      errs.some((e) => e.includes('credentials missing')),
      `expected a credentials-missing warning, got: ${JSON.stringify(errs)}`
    );
    const noPass = validateMailSettings({ ...WS1, 'smtp.pass': '' });
    assert.ok(noPass.some((e) => e.includes('smtp.pass is empty')), JSON.stringify(noPass));
    assert.deepEqual(validateMailSettings({}), []);
  });

  await check('C5: seeding can never overwrite stored values (INSERT IGNORE everywhere)', () => {
    const plat = fs.readFileSync(path.join(root, 'server/platform.js'), 'utf8');
    assert.ok(plat.includes('INSERT IGNORE INTO platform_settings'));
    const wsDb = fs.readFileSync(path.join(root, 'server/workspaceDb.js'), 'utf8');
    assert.ok(wsDb.includes('INSERT OR IGNORE INTO settings'));
    const ws = fs.readFileSync(path.join(root, 'server/workspace.js'), 'utf8');
    assert.ok(ws.includes('INSERT IGNORE INTO workspace_settings'));
  });

  await check('C6: forgot-password on a fresh install answers fast (no doomed outbound connection)', async () => {
    const db = require(path.join(root, 'server/db.js'));
    await db.migrate();
    await platform.seedPlatformDefaults();
    assert.equal(await platform.getPlatformSetting('smtp.host', ''), '');
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('batch55-test-password', 4);
    await db.query('INSERT INTO users (email, password_hash, name) VALUES (:email, :hash, :name)', {
      email: 'b55-reset@example.com',
      hash,
      name: 'Batch55 Reset',
    });
    const { requestReset } = require(path.join(root, 'server/passwordReset.js'));
    const t0 = Date.now();
    const res = await requestReset('b55-reset@example.com');
    const elapsed = Date.now() - t0;
    assert.deepEqual(res, { ok: true });
    assert.ok(elapsed < 5000, `requestReset took ${elapsed}ms — the pre-fix seed hung >30s here`);
  });
}

/* ---------------- D. Archive pins ---------------- */

function walkGraph(entry) {
  const seen = new Set();
  const unresolved = [];
  const stack = [entry];
  const resolveReq = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
  };
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.endsWith('.js')) continue;
    // Strip comments first: doc headers quote example require() calls
    // (e.g. src/ai.js shows require('../ai') as usage documentation) —
    // those are not runtime edges.
    const src = fs
      .readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[\s;])\/\/.*$/gm, '$1');
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      if (!m[1].startsWith('.')) continue; // bare specifier: package/builtin, not a repo path
      const r = resolveReq(f, m[1]);
      if (r) stack.push(r);
      else unresolved.push(`${path.relative(root, f)} -> ${m[1]}`);
    }
  }
  return { seen, unresolved };
}

async function archiveSuite() {
  await check('D1: production require graph resolves fully and never enters archive/', () => {
    const { seen, unresolved } = walkGraph(path.join(root, 'server.js'));
    assert.deepEqual(unresolved, []);
    const inArchive = [...seen].filter((p) => p.includes(`${path.sep}archive${path.sep}`));
    assert.deepEqual(inArchive, []);
    assert.ok(seen.size >= 140, `graph shrank unexpectedly: ${seen.size}`);
  });

  await check('D2: no root-level duplicate engines remain (server.js is the only root .js)', () => {
    const rootJs = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
    assert.deepEqual(rootJs, ['server.js']);
    const serverNames = new Set(fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.js')));
    const srcNames = new Set(fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')));
    for (const f of rootJs) {
      if (f === 'server.js') continue;
      assert.ok(!serverNames.has(f) && !srcNames.has(f), `root duplicate remains: ${f}`);
    }
  });

  await check('D3: the legacy tree is intact under archive/ and gone from its old homes', () => {
    const arch = path.join(root, 'archive/legacy-electron');
    for (const rel of [
      'main.js',
      'preload.js',
      'domain.js',
      'websiteEngine.js',
      'siteModules.js',
      'clientPortal.js',
      'renderer/index.html',
      'server.js.tmp/server.js',
      'src/db.js',
      'src/authorContentScan.js',
      'README.md',
    ]) {
      assert.ok(fs.existsSync(path.join(arch, rel)), `missing from archive: ${rel}`);
    }
    for (const rel of ['domain.js', 'main.js', 'websiteEngine.js', 'renderer', 'server.js.tmp', 'src/db.js', 'src/authorContentScan.js']) {
      assert.ok(!fs.existsSync(path.join(root, rel)), `still at old home: ${rel}`);
    }
    // Documented exception: src/ipc stays in the live tree — two
    // regression files reference it by path (batch47 requires
    // src/ipc/leads.js and registers it; seo-base-url source-scans
    // src/ipc/domains.js). The Batch 55 archive README carries the why.
    for (const rel of ['src/ipc/leads.js', 'src/ipc/domains.js']) {
      assert.ok(fs.existsSync(path.join(root, rel)), `test-referenced IPC handler missing: ${rel}`);
    }
  });

  await check('D4: build context excludes the archive; the Dockerfile COPY set is unchanged', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const copies = dockerfile
      .split('\n')
      .filter((l) => l.startsWith('COPY'))
      .map((l) => l.trim());
    assert.ok(!copies.some((l) => l.includes('archive')), `archive leaked into a COPY: ${JSON.stringify(copies)}`);
    for (const want of ['COPY server.js ./', 'COPY server ./server', 'COPY src ./src', 'COPY public ./public', 'COPY scripts ./scripts']) {
      assert.ok(copies.includes(want), `Dockerfile lost: ${want}`);
    }
    const ignoreLines = fs
      .readFileSync(path.join(root, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    assert.ok(ignoreLines.includes('archive'), '.dockerignore must exclude archive/');
  });
}

/* ---------------- run ---------------- */

(async () => {
  await smtpConfigSuite();
  await limiterSuite();
  await seedSuite();
  await smtpWireSuite();
  await archiveSuite();
  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify({ file: 'batch55-hygiene-regressions', checks: results.length, failed: failed.length, passed: failed.length === 0 })
  );
  if (failed.length) {
    for (const f of failed) console.error('FAILED:', f.name, '::', f.error);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
