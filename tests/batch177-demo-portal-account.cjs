'use strict';
/**
 * Batch 177 — demo portal account for standalone packages whose
 * client has NO portal account (Ely's ruling, 2026-11-10: "In the
 * case where no account exists create a demo account").
 *
 * Found by the Batch 155/168 bug hunt on Victoria's review install:
 * her lead (835) never had a portal account, so her clone booted
 * with zero portal accounts and the installer's closing summary
 * ("log in with the portal account from your BitPype site") pointed
 * at a login that does not exist.
 *
 * Pins:
 *  A. Generator, no-account fixture: the seed gains exactly one
 *     portal user — the demo account (demo-owner@standalone.invalid,
 *     active owner, target lead + workspace, the lead's business
 *     name, a bcrypt-format hash). manifest.seed.demoPortalAccount
 *     names it; platformTables counts it; a second generation is
 *     census-identical (hash value aside — it is bcrypt over a
 *     discarded random per package).
 *  B. Generator, has-account fixture: NO demo account anywhere;
 *     manifest.seed.demoPortalAccount is null; the seed's portal
 *     rows are byte-for-byte the pre-177 behaviour (the inserted
 *     account, hash string unchanged; platform seed byte-stable
 *     across two generations).
 *  C. Installer: bash-clean; the helper ships in the package
 *     (app/standalone/set-demo-password.js); install.sh carries both
 *     closing summaries (demo + the original has-account line) and
 *     the first-install pending marker; a dry run of a demo package
 *     lays the seed + marker down and names the demo account.
 *  D. Booted clone proof: from the demo package's dry-run install,
 *     the clone boots in single-site mode; BEFORE the install-time
 *     password set, no password logs the demo account in; running
 *     standalone/set-demo-password.js (the exact step install.sh
 *     runs) yields a one-time password that appears in NO package
 *     file and NO clone log; login with it succeeds, /me resolves
 *     the target lead's business, and a wrong password is refused.
 *
 * Real-server parts follow the sibling header convention:
 * CAPTCHA_OPTIONAL=1 + APP_URL are set for the spawned servers.
 */
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch177-'));
if (process.env.REGRESSION_DB_DRIVER === 'mysql') {
  process.env.DB_DRIVER = 'mysql';
  process.env.MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ws_gate_batch177';
} else {
  process.env.DB_DRIVER = 'sqlite';
}
process.env.SQLITE_PATH = path.join(tmpRoot, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(tmpRoot, 'workspaces');
process.env.EXPORT_ROOT = path.join(tmpRoot, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = ['batch177', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.from('batch177-settings-key-32-bytes!!').toString('base64');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL - ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

const OWNER_PW = ['Batch177', 'Owner', 'Pass'].join('-') + '!';
const KNOWN_PORTAL_PW = ['Batch177', 'Portal', 'Pass'].join('-') + '!';
const LEAD_C = 17701; // no portal account -> demo
const LEAD_D = 17702; // has a portal account -> untouched
const DEMO_EMAIL = 'demo-owner@standalone.invalid';

function walkFiles(dir, base) {
  const out = [];
  const b = base || dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, b));
    else if (entry.isFile()) out.push(path.relative(b, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

function makeJar() {
  const cookies = new Map();
  return {
    absorb(res) {
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const pair = String(line).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    async fetch(url, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'https';
      const cookie = this.header();
      if (cookie) headers.cookie = cookie;
      const res = await fetch(url, { ...options, headers, redirect: 'manual' });
      this.absorb(res);
      return res;
    },
  };
}

async function waitForHealth(port, child, label) {
  const deadline = Date.now() + 90000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`${label} exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
      lastErr = new Error(`health ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label} never became healthy: ${lastErr && lastErr.message}`);
}

function spawnServer({ cwd, port, env }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.logs = '';
  child.stdout.on('data', (d) => (child.logs += d));
  child.stderr.on('data', (d) => (child.logs += d));
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)).then(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }),
  ]);
}

function seedPortalRows(pkgDir) {
  const Database = require(path.join(root, 'node_modules/better-sqlite3'));
  const db = new Database(path.join(pkgDir, 'seed/platform.sqlite'), { readonly: true });
  const rows = db
    .prepare(
      'SELECT email, password_hash, workspace_id, lead_id, business_name, status, user_type FROM client_portal_users ORDER BY id'
    )
    .all();
  db.close();
  return rows;
}

async function makeSiteFixture({ platformDb, workspace, openWorkspaceDb, sm, chatbot, tag, leadId, business, withPortal }) {
  const a = await workspace.createUserWithWorkspace({
    email: `owner-${tag}@example.com`,
    password: OWNER_PW,
    name: `Owner ${tag}`,
    workspaceName: `Batch177 ${tag}`,
  });
  const ws = Number(a.workspaceId || a.workspace_id || a.id);
  assert.ok(ws > 0, `workspace ${tag} created`);
  const db = openWorkspaceDb(ws);
  sm.ensureTables(db);
  chatbot.ensureTables(db);
  db.prepare(
    `INSERT INTO leads (id, business_name, email, phone, city, category, status)
     VALUES (?, ?, ?, '555-0177', 'Reading', 'Florist', 'customer')`
  ).run(leadId, business, `lead-${tag}@example.com`);
  const pages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'heading', content: { title: business } },
        { type: 'text', content: { body: `Welcome to ${business}.` } },
      ],
    },
  ];
  const theme = {
    colors: { primary: '#1d4633', accent: '#d9a441', bg: '#fffaf5', text: '#22301f' },
    fonts: { heading: 'Fraunces', body: 'Figtree' },
  };
  db.prepare('INSERT INTO websites (id, lead_id, name, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
    leadId,
    leadId,
    business,
    JSON.stringify(pages),
    JSON.stringify(theme)
  );
  let portalHash = null;
  if (withPortal) {
    const bcrypt = require(path.join(root, 'node_modules/bcryptjs'));
    portalHash = bcrypt.hashSync(KNOWN_PORTAL_PW, 12);
    await platformDb.query(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :ws, :lead, :name, 'active', 'owner')`,
      { e: `client-${tag}@example.com`, h: portalHash, ws, lead: leadId, name: business }
    );
  }
  return { ws, portalHash };
}

async function main() {
  const platformDb = require(path.join(root, 'server/db.js'));
  const platform = require(path.join(root, 'server/platform.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const chatbot = require(path.join(root, 'server/chatbot.js'));
  const backup = require(path.join(root, 'server/standaloneBackup.js'));

  await platformDb.migrate();
  await platform.seedPlatformDefaults();

  check('generator exports the demo email constant', backup.DEMO_PORTAL_EMAIL === DEMO_EMAIL);

  /* ------------------------------------------------- A: no account */
  console.log('batch177 part A: no-account fixture gains a demo account');
  const c = await makeSiteFixture({
    platformDb,
    workspace,
    openWorkspaceDb,
    sm,
    chatbot,
    tag: 'c177',
    leadId: LEAD_C,
    business: 'Batch 177 Blooms',
    withPortal: false,
  });
  const genC1Dir = path.join(tmpRoot, 'genC1');
  fs.mkdirSync(genC1Dir, { recursive: true });
  const genC1 = await backup.generateStandaloneBackup({ workspaceId: c.ws, websiteId: LEAD_C, workDir: genC1Dir });
  const pkgC = genC1.packageDir;
  const manifestC = JSON.parse(fs.readFileSync(path.join(pkgC, 'manifest.json'), 'utf8'));
  check('manifest names the demo account', manifestC.seed.demoPortalAccount === DEMO_EMAIL, JSON.stringify(manifestC.seed.demoPortalAccount));
  check(
    'manifest table counts include the demo account',
    manifestC.seed.platformTables.client_portal_users === 1,
    JSON.stringify(manifestC.seed.platformTables.client_portal_users)
  );
  const manifestText = fs.readFileSync(path.join(pkgC, 'manifest.json'), 'utf8');
  check('manifest carries no password material', !/"password/i.test(manifestText));
  const rowsC = seedPortalRows(pkgC);
  check('seed holds exactly one portal user (the demo account)', rowsC.length === 1, JSON.stringify(rowsC.map((r) => r.email)));
  const demo = rowsC[0] || {};
  check(
    'demo row shape: email + workspace + lead + business + active owner',
    demo.email === DEMO_EMAIL &&
      Number(demo.workspace_id) === c.ws &&
      Number(demo.lead_id) === LEAD_C &&
      demo.business_name === 'Batch 177 Blooms' &&
      demo.status === 'active' &&
      demo.user_type === 'owner',
    JSON.stringify(demo)
  );
  check(
    'demo row carries a bcrypt hash (cost 12), not plaintext',
    /^\$2[aby]\$12\$/.test(String(demo.password_hash || '')),
    String(demo.password_hash || '').slice(0, 7)
  );

  const genC2Dir = path.join(tmpRoot, 'genC2');
  fs.mkdirSync(genC2Dir, { recursive: true });
  const genC2 = await backup.generateStandaloneBackup({ workspaceId: c.ws, websiteId: LEAD_C, workDir: genC2Dir });
  const manifestC2 = JSON.parse(fs.readFileSync(path.join(genC2.packageDir, 'manifest.json'), 'utf8'));
  const rowsC2 = seedPortalRows(genC2.packageDir);
  check('second generation names the same demo account', manifestC2.seed.demoPortalAccount === DEMO_EMAIL);
  check(
    'second generation census-identical (hash value aside)',
    rowsC2.length === 1 &&
      rowsC2[0].email === demo.email &&
      rowsC2[0].business_name === demo.business_name &&
      /^\$2[aby]\$12\$/.test(String(rowsC2[0].password_hash || '')) &&
      rowsC2[0].password_hash !== demo.password_hash,
    JSON.stringify(rowsC2.map((r) => r.email))
  );

  /* ------------------------------------------------ B: has account */
  console.log('batch177 part B: has-account fixture is untouched');
  const d = await makeSiteFixture({
    platformDb,
    workspace,
    openWorkspaceDb,
    sm,
    chatbot,
    tag: 'd177',
    leadId: LEAD_D,
    business: 'Batch 177 Gardens',
    withPortal: true,
  });
  const genD1Dir = path.join(tmpRoot, 'genD1');
  fs.mkdirSync(genD1Dir, { recursive: true });
  const genD1 = await backup.generateStandaloneBackup({ workspaceId: d.ws, websiteId: LEAD_D, workDir: genD1Dir });
  const manifestD = JSON.parse(fs.readFileSync(path.join(genD1.packageDir, 'manifest.json'), 'utf8'));
  check('manifest demo field is null when an account exists', manifestD.seed.demoPortalAccount === null);
  const rowsD = seedPortalRows(genD1.packageDir);
  check(
    'seed holds exactly the real account, hash string unchanged',
    rowsD.length === 1 && rowsD[0].email === 'client-d177@example.com' && rowsD[0].password_hash === d.portalHash,
    JSON.stringify(rowsD.map((r) => r.email))
  );
  check(
    'no demo identity anywhere in the has-account seed',
    !rowsD.some((r) => String(r.email).includes('demo')),
    JSON.stringify(rowsD.map((r) => r.email))
  );
  const genD2Dir = path.join(tmpRoot, 'genD2');
  fs.mkdirSync(genD2Dir, { recursive: true });
  const genD2 = await backup.generateStandaloneBackup({ workspaceId: d.ws, websiteId: LEAD_D, workDir: genD2Dir });
  const manifestD2 = JSON.parse(fs.readFileSync(path.join(genD2.packageDir, 'manifest.json'), 'utf8'));
  check(
    'has-account platform seed stays byte-stable across generations',
    manifestD.files['seed/platform.sqlite'] === manifestD2.files['seed/platform.sqlite']
  );

  /* -------------------------------------------------- C: installer */
  console.log('batch177 part C: installer assets + dry run');
  let bashOk = true;
  try {
    execFileSync('bash', ['-n', path.join(pkgC, 'install.sh')], { stdio: 'pipe' });
  } catch {
    bashOk = false;
  }
  check('install.sh is bash -n clean', bashOk);
  let helperOk = true;
  try {
    execFileSync(process.execPath, ['--check', path.join(pkgC, 'app/standalone/set-demo-password.js')], {
      stdio: 'pipe',
    });
  } catch {
    helperOk = false;
  }
  check('package ships app/standalone/set-demo-password.js (node --check clean)', helperOk);
  const installSrc = fs.readFileSync(path.join(pkgC, 'install.sh'), 'utf8');
  check(
    'install.sh wires the demo flow (manifest read, pending marker, helper, both summaries)',
    installSrc.includes('demoPortalAccount') &&
      installSrc.includes('.demo-password-pending') &&
      installSrc.includes('set-demo-password.js') &&
      installSrc.includes('CHANGE the password right away') &&
      installSrc.includes('log in with the portal account from your BitPype site'),
    ''
  );

  const installDir = path.join(tmpRoot, 'installC');
  const installEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SSB_DOMAIN: 'clone177.test',
    SSB_DRY_RUN: '1',
    SSB_INSTALL_DIR: installDir,
  };
  let dryOut = '';
  try {
    dryOut = execFileSync('bash', [path.join(pkgC, 'install.sh')], {
      env: installEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    dryOut = String(e.stdout || '') + String(e.stderr || '');
    check('installer dry run exits 0', false, dryOut.slice(-600));
  }
  check(
    'dry run completes, names the demo account, and lays down the pending marker',
    dryOut.includes('DRY RUN complete') &&
      dryOut.includes(DEMO_EMAIL) &&
      fs.existsSync(path.join(installDir, 'data', '.demo-password-pending')),
    dryOut.slice(-300)
  );

  /* --------------------------------------------- D: booted clone proof */
  console.log('batch177 part D: clone boot + install-time password + login');
  const appDir = path.join(installDir, 'app');
  const nmLink = path.join(appDir, 'node_modules');
  if (!fs.existsSync(nmLink)) fs.symlinkSync(path.join(root, 'node_modules'), nmLink, 'junction');
  const envText = fs.readFileSync(path.join(installDir, '.env'), 'utf8');
  const cloneEnvFile = {};
  for (const line of envText.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) cloneEnvFile[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const CLONE_PORT = 43177;
  const clone = spawnServer({
    cwd: appDir,
    port: CLONE_PORT,
    env: {
      NODE_ENV: 'production',
      CAPTCHA_OPTIONAL: '1',
      APP_URL: 'https://clone177.test',
      BITPYPE_SINGLE_SITE: '1',
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: path.join(installDir, 'data', 'platform.sqlite'),
      WORKSPACE_DATA_DIR: path.join(installDir, 'data', 'workspaces'),
      EXPORT_ROOT: path.join(installDir, 'data', 'exports'),
      SINGLE_SITE_SITE_DIR: path.join(installDir, 'site'),
      SESSION_SECRET: cloneEnvFile.SESSION_SECRET,
      SETTINGS_ENCRYPTION_KEY: cloneEnvFile.SETTINGS_ENCRYPTION_KEY,
    },
  });
  const base = `http://127.0.0.1:${CLONE_PORT}`;
  try {
    await waitForHealth(CLONE_PORT, clone, 'clone177');
    check('demo clone boots and answers /health', true);
    const home = await fetch(`${base}/`);
    const homeText = await home.text();
    check('clone serves the baked site', home.status === 200 && homeText.includes('Batch 177 Blooms'), `status ${home.status}`);

    const jar = makeJar();
    const preLogin = await jar.fetch(`${base}/api/v1/portal/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, password: 'anything-wrong-177' }),
    });
    await preLogin.text();
    check('before the install-time set, the demo account accepts no password', preLogin.status === 401, `status ${preLogin.status}`);

    /* The exact step install.sh runs inside the app container. */
    let demoPassword = '';
    try {
      demoPassword = execFileSync(
        process.execPath,
        [path.join(appDir, 'standalone', 'set-demo-password.js'), DEMO_EMAIL],
        {
          env: { ...process.env, SQLITE_PATH: path.join(installDir, 'data', 'platform.sqlite') },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      ).trim();
    } catch (e) {
      check('set-demo-password.js runs against the clone DB', false, String(e.stderr || e.message).slice(-300));
    }
    check(
      'set-demo-password.js returns a one-time password (>= 12 chars)',
      demoPassword.length >= 12,
      `len ${demoPassword.length}`
    );
    let pwInPackage = 0;
    if (demoPassword) {
      for (const rel of walkFiles(pkgC)) {
        const text = fs.readFileSync(path.join(pkgC, rel)).toString('latin1');
        if (text.includes(demoPassword)) pwInPackage++;
      }
    }
    check('the one-time password exists in NO package file', pwInPackage === 0, `${pwInPackage} files`);
    check('the one-time password appears in NO clone log line', demoPassword !== '' && !clone.logs.includes(demoPassword));

    const login = await jar.fetch(`${base}/api/v1/portal/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, password: demoPassword }),
    });
    const loginText = await login.text();
    check('demo login succeeds with the install-time password', login.status === 200, `status ${login.status}: ${loginText.slice(0, 200)}`);
    const me = await jar.fetch(`${base}/api/v1/portal/me`);
    const meText = await me.text();
    check(
      'demo session resolves the target lead business (/me)',
      me.status === 200 && meText.includes('Batch 177 Blooms'),
      `status ${me.status}: ${meText.slice(0, 200)}`
    );
    const wrong = await jar.fetch(`${base}/api/v1/portal/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, password: demoPassword + 'x' }),
    });
    await wrong.text();
    check('a wrong demo password is refused', wrong.status === 401, `status ${wrong.status}`);
  } finally {
    await stopServer(clone);
  }
}

main()
  .then(() => {
    console.log(`\nbatch177: ${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('failures:\n - ' + failures.join('\n - '));
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error('batch177 suite error:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
