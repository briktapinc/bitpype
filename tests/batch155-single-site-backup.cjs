'use strict';
/**
 * Batch 155 — Standalone Site Backup (CLONE model) regressions.
 *
 * Spec: ~/workspace/website-scout/standalone-site-backup-spec.md
 *
 * Pins, in spec order:
 *  §3 single-site mode: the env flag is read in ONE module
 *     (server/singleSite.js); the disabled-route census is exact;
 *     boot defaults collapse platform config onto owner env values
 *     and honestly mark platform-bound services unavailable.
 *  §2/§4 the generator: package layout, manifest + per-file sha256,
 *     FULL detail-content bake, zero platform-host references in
 *     site/, seed platform DB carrying ONLY the target workspace's
 *     rows, tenant DB complete, no second workspace's data and no
 *     platform secret anywhere in the package, generator
 *     idempotency.
 *  §5 the installer: bash syntax, checksum verification (a tampered
 *     package is refused), SSB_* env-mode dry run producing a 0600
 *     .env with BITPYPE_SINGLE_SITE=1 and the seeded data layout —
 *     stopping BEFORE Docker (this sandbox has no Docker; the
 *     clean-room container proof is the deploy phase's job).
 *  §8.1 the sandbox proof: a clone booted from the generated
 *     package ALONE (fresh dirs, child process, test port,
 *     all-SQLite, SINGLE_SITE=1) serves the baked site incl. detail
 *     content, logs the seeded portal owner in, lands a form
 *     submission in its OWN tenant DB, attempts checkout against
 *     the seeded catalog with a fake Stripe key and fails ONLY at
 *     the Stripe boundary, 404s every staff route in the census and
 *     refuses registration — while a mode-OFF boot of the same tree
 *     answers staff routes normally.
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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch155-'));
if (process.env.REGRESSION_DB_DRIVER === 'mysql') {
  process.env.DB_DRIVER = 'mysql';
  process.env.MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ws_gate_batch155';
} else {
  process.env.DB_DRIVER = 'sqlite';
}
process.env.SQLITE_PATH = path.join(tmpRoot, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(tmpRoot, 'workspaces');
process.env.EXPORT_ROOT = path.join(tmpRoot, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = ['batch155', 'session', 'secret', 'value'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.from('batch155-settings-key-32-bytes!!').toString('base64');

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

const OWNER_PW = ['Batch155', 'Owner', 'Pass'].join('-') + '!';
const PORTAL_PW = ['Batch155', 'Portal', 'Pass'].join('-') + '!';
const FAKE_STRIPE_SECRET = ['sk', 'test', 'batch155', 'fake'].join('_');
const FAKE_OPENAI_KEY = ['sk', 'batch155', 'fake', 'openai'].join('-');
const PLATFORM_MARKER = 'batch155-platform-only-marker-value';
const DECOY_MARKERS = ['Decoy Biz 155', 'decoy-b155@example.com', 'Decoy Product 155', 'decoy secret phrase 155'];

const LEAD_A = 15501;
const LEAD_B = 15502;

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

function sha256File(abs) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
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
      // The app issues Secure session cookies; behind the install's
      // Caddy it sees X-Forwarded-Proto: https (the production proof
      // pattern) — mirror that here or express-session withholds the
      // cookie on the plain-HTTP test hop.
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

async function main() {
  const platformDb = require(path.join(root, 'server/db.js'));
  const platform = require(path.join(root, 'server/platform.js'));
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const chatbot = require(path.join(root, 'server/chatbot.js'));
  const contactForms = require(path.join(root, 'server/contactForms.js'));
  const singleSite = require(path.join(root, 'server/singleSite.js'));
  const backup = require(path.join(root, 'server/standaloneBackup.js'));
  const bcrypt = require(path.join(root, 'node_modules/bcryptjs'));

  await platformDb.migrate();
  await platform.seedPlatformDefaults();
  // A platform-level secret that must NEVER reach a package.
  await platform.setPlatformSetting('ai.api_key', PLATFORM_MARKER);

  /* ------------------------------------------------ fixture: WS A (target) */
  const a = await workspace.createUserWithWorkspace({
    email: 'owner-a155@example.com',
    password: OWNER_PW,
    name: 'Owner A155',
    workspaceName: 'Batch155 A',
  });
  const wsA = Number(a.workspaceId || a.workspace_id || a.id);
  assert.ok(wsA > 0, 'workspace A created');
  // A workspace-owned (non-platform) setting that MUST survive the
  // seed copy — the positive control for the §6 key-drop filter.
  await platformDb.query(
    `INSERT INTO workspace_settings (workspace_id, \`key\`, \`value\`) VALUES (:ws, 'custom.client_note', 'keep-me-155')`,
    { ws: wsA }
  );
  const dbA = openWorkspaceDb(wsA);
  sm.ensureTables(dbA);
  chatbot.ensureTables(dbA);
  dbA
    .prepare(
      `INSERT INTO leads (id, business_name, email, phone, city, category, status)
       VALUES (?, 'Batch 155 Blooms', 'victoria155@example.com', '555-0155', 'Reading', 'Florist', 'customer')`
    )
    .run(LEAD_A);
  const pages = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'heading', content: { title: 'Batch 155 Blooms' } },
        { type: 'text', content: { body: 'Fresh flowers from the Batch 155 fixture garden.' } },
      ],
    },
    {
      slug: 'shop',
      title: 'Shop',
      sections: [
        { type: 'heading', content: { title: 'Shop' } },
        { type: 'module', content: { module_type: 'ecommerce', module_token: 'b155-shop' } },
      ],
    },
  ];
  const theme = {
    colors: { primary: '#1d6f4f', accent: '#e8b4b8', bg: '#fffaf5', text: '#22301f' },
    fonts: { heading: 'Fraunces', body: 'Figtree' },
  };
  dbA
    .prepare('INSERT INTO websites (id, lead_id, name, pages, theme) VALUES (?, ?, ?, ?, ?)')
    .run(15501, LEAD_A, 'Batch 155 Blooms', JSON.stringify(pages), JSON.stringify(theme));
  const monstera = sm.createProduct(dbA, LEAD_A, {
    name: 'Monstera Deliciosa',
    description: 'Batch155 signature plant.',
    status: 'published',
    price_cents: 5800,
    options: [{ name: 'Pot', values: ['Nursery Pot', 'EcoPot'] }],
    variants: [{ values: ['EcoPot'], price_cents: 6800 }],
  });
  sm.createBookingService(dbA, LEAD_A, { name: 'Potting Session 155', duration_minutes: 45, price_cents: 2500 });
  sm.createFaqItem(dbA, LEAD_A, { question: 'Do you deliver?', answer: 'Yes, locally.', status: 'published' });
  sm.createBlogPost(dbA, LEAD_A, { title: 'Monstera care notes', body: 'Water weekly.', status: 'published' });
  chatbot.addKnowledge(dbA, LEAD_A, {
    title: 'Care',
    content: 'Batch155 KB marker: monstera likes bright indirect light.',
  });
  const form = contactForms.createForm(dbA, LEAD_A, { name: 'Contact 155' });
  contactForms.publishForm(dbA, LEAD_A, form.id, { workspaceId: wsA });
  const formRow = dbA.prepare('SELECT public_token FROM contact_forms WHERE id = ?').get(form.id);
  const formToken = formRow && formRow.public_token;
  assert.ok(formToken, 'fixture form has a public token');
  const embedTokens = {};
  for (const type of ['ecommerce', 'checkout', 'chatbot', 'bookings']) {
    const row = sm.ensureEmbed(dbA, LEAD_A, type, { workspaceId: wsA });
    dbA.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(row.id);
    embedTokens[type] = row.public_token;
  }
  assert.ok(embedTokens.ecommerce, 'fixture shop embed has a public token');
  // Point the shop page's module section at the real embed token.
  const pagesRow = dbA.prepare('SELECT pages FROM websites WHERE id = 15501').get();
  dbA
    .prepare('UPDATE websites SET pages = ? WHERE id = 15501')
    .run(String(pagesRow.pages).split('b155-shop').join(embedTokens.ecommerce));
  await platformDb.query(
    `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status)
     VALUES (:e, :h, :ws, :lead, 'Batch 155 Blooms', 'active')`,
    { e: 'client-a155@example.com', h: bcrypt.hashSync(PORTAL_PW, 12), ws: wsA, lead: LEAD_A }
  );

  /* ------------------------------------------------ fixture: WS B (decoy) */
  const b = await workspace.createUserWithWorkspace({
    email: 'owner-b155@example.com',
    password: OWNER_PW,
    name: 'Owner B155',
    workspaceName: 'Decoy Biz 155',
  });
  const wsB = Number(b.workspaceId || b.workspace_id || b.id);
  assert.ok(wsB > 0 && wsB !== wsA, 'workspace B created');
  const dbB = openWorkspaceDb(wsB);
  sm.ensureTables(dbB);
  chatbot.ensureTables(dbB);
  dbB
    .prepare(
      `INSERT INTO leads (id, business_name, email, status) VALUES (?, 'Decoy Biz 155', 'decoy-b155@example.com', 'customer')`
    )
    .run(LEAD_B);
  dbB
    .prepare('INSERT INTO websites (id, lead_id, name, pages, theme) VALUES (?, ?, ?, ?, ?)')
    .run(15502, LEAD_B, 'Decoy Biz 155', JSON.stringify(pages), JSON.stringify(theme));
  sm.createProduct(dbB, LEAD_B, { name: 'Decoy Product 155', price_cents: 100, status: 'published' });
  chatbot.addKnowledge(dbB, LEAD_B, { title: 'Decoy', content: 'decoy secret phrase 155' });

  /* --------------------------------------- §3 pins: one-place flag + census */
  console.log('batch155 part A: single-site module pins');
  check('flag is OFF by default in the platform process', singleSite.isSingleSite() === false);
  check(
    'API census covers staff auth/admin/billing',
    ['/api/v1/auth', '/api/v1/admin', '/api/v1/billing'].every((p) => singleSite.DISABLED_API_PREFIXES.includes(p))
  );
  check(
    'API census covers partner + deployer + MCP surfaces',
    ['/api/v1/partner', '/api/v1/hostinger-deploy', '/mcp', '/api/v1/mcp'].every((p) =>
      singleSite.DISABLED_API_PREFIXES.includes(p)
    )
  );
  check(
    'page census covers the staff app + marketing pages',
    ['/app', '/solo', '/landing'].every((p) => singleSite.DISABLED_PAGES.includes(p))
  );
  check(
    'portal + public module + forms paths are NOT in the census',
    !singleSite.DISABLED_API_PREFIXES.some((p) => p.includes('portal') || p.includes('modules') || p.includes('forms'))
  );
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  check(
    'server.js reads the flag only via server/singleSite.js',
    !/process\.env\.BITPYPE_SINGLE_SITE/.test(serverSrc) && /require\(['"]\.\/server\/singleSite['"]\)/.test(serverSrc)
  );
  const singleSiteSrc = fs.readFileSync(path.join(root, 'server/singleSite.js'), 'utf8');
  check('singleSite.js is the one place the env flag is read', /process\.env\.BITPYPE_SINGLE_SITE/.test(singleSiteSrc));

  /* --------------------------------------------- §2/§4 generator + package */
  console.log('batch155 part B: package generator');
  const genDir1 = path.join(tmpRoot, 'gen1');
  fs.mkdirSync(genDir1, { recursive: true });
  const gen1 = await backup.generateStandaloneBackup({ workspaceId: wsA, websiteId: 15501, workDir: genDir1 });
  const pkg = gen1.packageDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'));
  check('manifest format + version', manifest.format === 'bitpype-standalone-backup' && manifest.formatVersion === 1);
  check(
    'manifest source ids point at workspace A + site 15501',
    manifest.source.workspaceId === wsA && manifest.source.websiteId === 15501 && manifest.source.leadId === LEAD_A
  );
  check(
    'manifest feature flags: shop + chat + forms on',
    manifest.features.hasShop === true && manifest.features.hasChat === true && manifest.features.hasForms === true
  );
  check('manifest carries the app git sha', typeof manifest.app.gitSha === 'string' && manifest.app.gitSha.length >= 7);
  const pkgFiles = walkFiles(pkg);
  check(
    'package layout: site/ + seed/ + app/ + installer files',
    [
      'site/index.html',
      'seed/platform.sqlite',
      'seed/tenant.sqlite',
      'install.sh',
      'uninstall.sh',
      'docker-compose.yml',
      'Caddyfile',
      'app/server.js',
      'app/standalone/install.sh',
      'app/server/singleSite.js',
    ].every((f) => pkgFiles.includes(f))
  );
  const manifestFiles = Object.keys(manifest.files);
  check(
    'manifest hashes every packaged file but itself',
    manifestFiles.length === pkgFiles.length - 1 && manifestFiles.every((f) => f !== 'manifest.json')
  );
  check(
    'every manifest hash verifies',
    manifestFiles.every((f) => manifest.files[f] === sha256File(path.join(pkg, f)))
  );

  const detailRel = 'site/detail/ecommerce/monstera-deliciosa.html';
  check('detail shell exported for the fixture product', pkgFiles.includes(detailRel));
  const detailHtml = fs.readFileSync(path.join(pkg, detailRel), 'utf8');
  check(
    'detail page carries FULL baked content (name + variant price)',
    detailHtml.includes('Monstera Deliciosa') && detailHtml.includes('68.00') && detailHtml.includes('58.00'),
    detailHtml.slice(0, 200)
  );
  check(
    'detail page is not the loading shell anymore',
    !detailHtml.includes('bp-mod-loading') && !detailHtml.includes('Loading')
  );
  check('manifest reports the baked detail page', manifest.bake.detailPages >= 1, JSON.stringify(manifest.bake));

  let siteRefs = 0;
  for (const rel of walkFiles(path.join(pkg, 'site'))) {
    if (!/\.(html|js|json|xml|txt|css|svg)$/i.test(rel)) continue;
    const text = fs.readFileSync(path.join(pkg, 'site', rel), 'utf8');
    if (/bitpype\.com/i.test(text) || /bitpype\.test/i.test(text)) siteRefs++;
  }
  check('zero platform-host references survive in site/', siteRefs === 0, `${siteRefs} offending files`);

  /* census: read EVERY package file and hunt decoy + platform secrets */
  const leaks = [];
  for (const rel of pkgFiles) {
    const buf = fs.readFileSync(path.join(pkg, rel));
    const text = buf.toString('latin1');
    for (const marker of [...DECOY_MARKERS, PLATFORM_MARKER]) {
      if (text.includes(marker)) leaks.push(`${rel} contains ${marker}`);
    }
  }
  check('package census: no decoy-workspace data, no platform secret', leaks.length === 0, leaks.join(' | '));

  const Database = require(path.join(root, 'node_modules/better-sqlite3'));
  const seedDb = new Database(path.join(pkg, 'seed/platform.sqlite'), { readonly: true });
  const seedWs = seedDb
    .prepare('SELECT id FROM workspaces')
    .all()
    .map((r) => r.id);
  check(
    'seed platform DB holds ONLY workspace A',
    seedWs.length === 1 && Number(seedWs[0]) === wsA,
    JSON.stringify(seedWs)
  );
  const seedPortal = seedDb
    .prepare('SELECT email FROM client_portal_users')
    .all()
    .map((r) => r.email);
  check(
    'seed portal users = the A owner only',
    seedPortal.length === 1 && seedPortal[0] === 'client-a155@example.com',
    JSON.stringify(seedPortal)
  );
  const seedSettings = seedDb.prepare('SELECT COUNT(*) AS c FROM platform_settings').get().c;
  check('seed carries NO platform settings (no platform secrets)', Number(seedSettings) === 0, `${seedSettings} rows`);
  seedDb.close();
  const seedTenant = new Database(path.join(pkg, 'seed/tenant.sqlite'), { readonly: true });
  const tenantProduct = seedTenant.prepare("SELECT name FROM ecommerce_products WHERE name LIKE 'Monstera%'").get();
  check('seed tenant DB carries the shop catalog', !!tenantProduct);
  const tenantKb = seedTenant
    .prepare("SELECT content_text FROM chatbot_knowledge WHERE content_text LIKE '%Batch155 KB marker%'")
    .get();
  check('seed tenant DB carries the chatbot knowledge base', !!tenantKb);
  seedTenant.close();
  const seedWsSettings = new Database(path.join(pkg, 'seed/platform.sqlite'), { readonly: true });
  const keptSetting = seedWsSettings
    .prepare("SELECT value FROM workspace_settings WHERE key = 'custom.client_note'")
    .get();
  check(
    "seed keeps the workspace's own (non-platform) settings",
    !!keptSetting && keptSetting.value === 'keep-me-155',
    JSON.stringify(keptSetting)
  );
  const droppedKey = seedWsSettings
    .prepare("SELECT COUNT(*) AS c FROM workspace_settings WHERE key = 'ai.api_key'")
    .get().c;
  check(
    'seed drops platform-scope setting keys by name (spec §6)',
    Number(droppedKey) === 0,
    `${droppedKey} ai.api_key rows`
  );
  seedWsSettings.close();

  /* idempotency: same state -> same package (manifest timestamp aside) */
  const genDir2 = path.join(tmpRoot, 'gen2');
  fs.mkdirSync(genDir2, { recursive: true });
  const gen2 = await backup.generateStandaloneBackup({ workspaceId: wsA, websiteId: 15501, workDir: genDir2 });
  // (The suite's own readonly seed opens can leave -shm sidecars in
  // gen1's dir after generation; those are test artifacts, not
  // package content — the generator sweeps its own before hashing.)
  const noSidecars = (f) => !/-(wal|shm|journal)$/.test(f);
  const files1 = walkFiles(gen1.packageDir).filter(noSidecars);
  const files2 = walkFiles(gen2.packageDir).filter(noSidecars);
  check('generator idempotency: identical file sets', JSON.stringify(files1) === JSON.stringify(files2));
  const drift = files1.filter(
    (f) =>
      f !== 'manifest.json' &&
      f !== 'seed/tenant.sqlite' &&
      sha256File(path.join(gen1.packageDir, f)) !== sha256File(path.join(gen2.packageDir, f))
  );
  check('generator idempotency: identical contents (manifest + tenant DB aside)', drift.length === 0, drift.join(', '));
  /* The tenant snapshot is compared LOGICALLY: exportStatic appends
   * its own activity_log row to the live tenant DB on every export,
   * so a second generation legitimately carries exactly one more
   * activity row than the first (and sqlite header counters move).
   * Every other table must be dump-identical. */
  const DatabaseB = require(path.join(root, 'node_modules/better-sqlite3'));
  const dumpTenant = (p) => {
    const d = new DatabaseB(p, { readonly: true });
    const out = {};
    for (const t of d
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)) {
      out[t] = d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    }
    d.close();
    return out;
  };
  const dump1 = dumpTenant(path.join(gen1.packageDir, 'seed/tenant.sqlite'));
  const dump2 = dumpTenant(path.join(gen2.packageDir, 'seed/tenant.sqlite'));
  const tenantTables = Object.keys(dump1);
  const tenantDrift = tenantTables.filter(
    (t) => t !== 'activity_log' && JSON.stringify(dump1[t]) !== JSON.stringify(dump2[t] || null)
  );
  check(
    'generator idempotency: tenant DB logically identical (activity_log aside)',
    tenantDrift.length === 0,
    tenantDrift.join(', ')
  );
  const act1 = dump1.activity_log || [];
  const act2 = dump2.activity_log || [];
  check(
    "generator idempotency: the only tenant delta is the export's own activity row",
    act2.length === act1.length + 1 && JSON.stringify(act2.slice(0, act1.length)) === JSON.stringify(act1),
    `activity rows ${act1.length} -> ${act2.length}`
  );
  const m1 = { ...manifest, generatedAt: null, files: { ...manifest.files } };
  const m2raw = JSON.parse(fs.readFileSync(path.join(gen2.packageDir, 'manifest.json'), 'utf8'));
  const m2 = { ...m2raw, generatedAt: null, files: { ...m2raw.files } };
  delete m1.files['seed/tenant.sqlite'];
  delete m2.files['seed/tenant.sqlite'];
  check(
    'generator idempotency: manifests equal except generatedAt + tenant hash',
    JSON.stringify(m1) === JSON.stringify(m2)
  );

  return { wsA, wsB, pkg, formToken, shopToken: 'b155-shop', productId: Number(monstera.id || monstera) };
}

async function installerAndClone(ctx) {
  const { wsA, pkg, formToken } = ctx;
  console.log('batch155 part C: installer (syntax, checksum, dry run)');
  for (const script of ['install.sh', 'uninstall.sh']) {
    let okSyntax = true;
    try {
      execFileSync('bash', ['-n', path.join(pkg, script)], { stdio: 'pipe' });
    } catch {
      okSyntax = false;
    }
    check(`${script} is bash -n clean`, okSyntax);
  }

  const installEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SSB_DOMAIN: 'clone155.test',
    SSB_DRY_RUN: '1',
    SSB_ADMIN_EMAIL: 'client-a155@example.com',
    SSB_STRIPE_PUBLISHABLE: ['pk', 'test', 'batch155', 'fake'].join('_'),
    SSB_STRIPE_SECRET: FAKE_STRIPE_SECRET,
    SSB_OPENAI_KEY: FAKE_OPENAI_KEY,
  };
  const installDir = path.join(tmpRoot, 'install');
  let dryOut = '';
  try {
    dryOut = execFileSync('bash', [path.join(pkg, 'install.sh')], {
      env: { ...installEnv, SSB_INSTALL_DIR: installDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    dryOut = String(e.stdout || '') + String(e.stderr || '');
    check('installer dry run exits 0', false, dryOut.slice(-600));
  }
  check(
    'installer dry run completes and stops before Docker',
    dryOut.includes('DRY RUN complete') && dryOut.includes('no containers were started'),
    dryOut.slice(-300)
  );
  const envPath = path.join(installDir, '.env');
  check('installer wrote .env', fs.existsSync(envPath));
  const envText = fs.readFileSync(envPath, 'utf8');
  check(
    '.env pins single-site mode + the wizard domain',
    envText.includes('BITPYPE_SINGLE_SITE=1') && envText.includes('APP_URL=https://clone155.test')
  );
  check(
    '.env carries the owner-supplied keys (env mode)',
    envText.includes(`SSB_STRIPE_SECRET=${FAKE_STRIPE_SECRET}`) && envText.includes(`SSB_OPENAI_KEY=${FAKE_OPENAI_KEY}`)
  );
  const envMode = fs.statSync(envPath).mode & 0o777;
  check('.env is mode 600', envMode === 0o600, `mode ${envMode.toString(8)}`);
  check(
    'installer seeded the data layout (platform + tenant + exports)',
    fs.existsSync(path.join(installDir, 'data', 'platform.sqlite')) &&
      fs.existsSync(path.join(installDir, 'data', 'workspaces', String(wsA), 'websitescout.db')) &&
      fs.existsSync(path.join(installDir, 'data', 'exports'))
  );
  check(
    'installer staged app + site + compose into the install dir',
    ['app/server.js', 'site/index.html', 'docker-compose.yml', 'Caddyfile'].every((f) =>
      fs.existsSync(path.join(installDir, f))
    )
  );

  /* a tampered package must be refused at checksum verification */
  const tamperDir = path.join(tmpRoot, 'tampered');
  fs.cpSync(pkg, tamperDir, { recursive: true });
  fs.writeFileSync(
    path.join(tamperDir, 'site', 'index.html'),
    fs.readFileSync(path.join(tamperDir, 'site', 'index.html'), 'utf8') + '\n<!-- tampered -->\n'
  );
  let tamperRefused = false;
  try {
    execFileSync('bash', [path.join(tamperDir, 'install.sh')], {
      env: { ...installEnv, SSB_INSTALL_DIR: path.join(tmpRoot, 'install-tampered') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    tamperRefused = /checksum/i.test(String(e.stdout || '') + String(e.stderr || ''));
  }
  check('installer refuses a package whose checksums do not verify', tamperRefused);

  /* ------------------------------------------- §8.1 clone boot from package */
  console.log('batch155 part D: clone boot proof (package alone, SINGLE_SITE=1)');
  // Sandbox stand-in for the Docker image build: the package's app/
  // tree ships without node_modules (the image build installs from
  // package-lock); link the worktree's installed modules in so the
  // clone child process can boot. Everything else — code, site,
  // seeds, .env — comes from the package alone.
  const appDir = path.join(installDir, 'app');
  const nmLink = path.join(appDir, 'node_modules');
  if (!fs.existsSync(nmLink)) fs.symlinkSync(path.join(root, 'node_modules'), nmLink, 'junction');
  const cloneEnv = {};
  for (const line of envText.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) cloneEnv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const CLONE_PORT = 43155;
  const clone = spawnServer({
    cwd: appDir,
    port: CLONE_PORT,
    env: {
      NODE_ENV: 'production',
      CAPTCHA_OPTIONAL: '1',
      APP_URL: 'https://clone155.test',
      BITPYPE_SINGLE_SITE: '1',
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: path.join(installDir, 'data', 'platform.sqlite'),
      WORKSPACE_DATA_DIR: path.join(installDir, 'data', 'workspaces'),
      EXPORT_ROOT: path.join(installDir, 'data', 'exports'),
      SINGLE_SITE_SITE_DIR: path.join(installDir, 'site'),
      SESSION_SECRET: cloneEnv.SESSION_SECRET,
      SETTINGS_ENCRYPTION_KEY: cloneEnv.SETTINGS_ENCRYPTION_KEY,
      SSB_STRIPE_PUBLISHABLE: cloneEnv.SSB_STRIPE_PUBLISHABLE,
      SSB_STRIPE_SECRET: cloneEnv.SSB_STRIPE_SECRET,
      SSB_OPENAI_KEY: cloneEnv.SSB_OPENAI_KEY,
    },
  });
  const base = `http://127.0.0.1:${CLONE_PORT}`;
  try {
    try {
      await waitForHealth(CLONE_PORT, clone, 'clone');
    } catch (e) {
      check(
        'clone boots from the package alone and answers /health',
        false,
        `${e.message} :: LOGS ${clone.logs.slice(-900)}`
      );
      throw e;
    }
    check('clone boots from the package alone and answers /health', true);
    check('clone boot log announces single-site mode', /\[single-site\]/.test(clone.logs), clone.logs.slice(0, 400));

    const home = await fetch(`${base}/`);
    const homeText = await home.text();
    check(
      'clone serves the baked site at /',
      home.status === 200 && homeText.includes('Batch 155 Blooms'),
      `status ${home.status}`
    );
    const detail = await fetch(`${base}/detail/ecommerce/monstera-deliciosa.html`);
    const detailText = await detail.text();
    check(
      'clone serves baked detail content (no client fetch needed)',
      detail.status === 200 &&
        detailText.includes('Monstera Deliciosa') &&
        detailText.includes('68.00') &&
        !detailText.includes('bp-mod-loading'),
      `status ${detail.status}`
    );

    const jar = makeJar();
    const login = await jar.fetch(`${base}/api/v1/portal/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'client-a155@example.com', password: PORTAL_PW }),
    });
    check(
      'seeded portal owner can log in to the clone',
      login.status === 200,
      `status ${login.status}: ${(await login.text()).slice(0, 200)}`
    );
    const me = await jar.fetch(`${base}/api/v1/portal/me`);
    check('clone portal session works (/me)', me.status === 200, `status ${me.status}`);

    const formRes = await fetch(`${base}/api/v1/forms/public/${encodeURIComponent(formToken)}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: { name: 'Ada Clone', email: 'ada@example.com', message: 'Hello from the clone proof' },
      }),
    });
    const formBody = await formRes.text();
    check(
      'clone accepts a public form submission',
      formRes.status === 200 && /"ok":true/.test(formBody),
      `status ${formRes.status}: ${formBody.slice(0, 200)}`
    );

    /* checkout: fake Stripe key collapsed in at boot via SSB env —
     * the attempt must clear config + catalog resolution and fail
     * ONLY at the Stripe boundary (auth/network), never earlier. */
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const tenantPath = path.join(installDir, 'data', 'workspaces', String(wsA), 'websitescout.db');
    const tdb = new Database(tenantPath, { readonly: true });
    const prod = tdb.prepare("SELECT id FROM ecommerce_products WHERE name LIKE 'Monstera%'").get();
    const variant = tdb
      .prepare('SELECT id FROM ecommerce_product_variants WHERE product_id = ? AND price_cents = 6800')
      .get(prod.id);
    const embedRow = tdb
      .prepare("SELECT public_token AS token FROM site_module_embeds WHERE module_type = 'ecommerce'")
      .get();
    tdb.close();
    const checkout = await fetch(`${base}/api/v1/modules/public/${encodeURIComponent(embedRow.token)}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId: Number(prod.id),
        variantId: Number(variant.id),
        returnUrl: 'https://clone155.test/thanks',
      }),
    });
    const checkoutText = await checkout.text();
    check(
      'checkout attempt against the seeded catalog fails ONLY at the Stripe boundary',
      checkout.status >= 400 &&
        !/not configured|PAYMENTS_NOT_CONFIGURED|PRODUCT_NOT_FOUND|VARIANT_NOT_FOUND|MODULE_NOT_FOUND/i.test(
          checkoutText
        ) &&
        /stripe|network|api_key|authentication|invalid/i.test(checkoutText),
      `status ${checkout.status}: ${checkoutText.slice(0, 300)} :: SS-LINES ${clone.logs
        .split('\n')
        .filter((l) => l.includes('single-site'))
        .join(' | ')
        .slice(0, 1200)}`
    );

    /* staff census over HTTP: every disabled prefix + page 404s */
    const singleSite = require(path.join(root, 'server/singleSite.js'));
    let censusBad = [];
    for (const prefix of singleSite.DISABLED_API_PREFIXES) {
      const res = await fetch(`${base}${prefix}/__census__`);
      if (res.status !== 404) censusBad.push(`GET ${prefix} -> ${res.status}`);
      const resPost = await fetch(`${base}${prefix}/__census__`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (resPost.status !== 404) censusBad.push(`POST ${prefix} -> ${resPost.status}`);
    }
    check(
      'route census: every disabled API prefix 404s on the clone (GET + POST)',
      censusBad.length === 0,
      censusBad.join(' | ')
    );
    let pageBad = [];
    for (const page of singleSite.DISABLED_PAGES) {
      const res = await fetch(`${base}${page}`);
      if (res.status !== 404) pageBad.push(`GET ${page} -> ${res.status}`);
    }
    check('route census: every disabled page 404s on the clone', pageBad.length === 0, pageBad.join(' | '));
    const reg = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'whatever-123', name: 'Nope', workspaceName: 'Nope' }),
    });
    check('registration is refused on the clone (404 — surface absent)', reg.status === 404, `status ${reg.status}`);
  } finally {
    await stopServer(clone);
  }

  /* the form submission must have landed in the CLONE's tenant DB */
  const Database2 = require(path.join(root, 'node_modules/better-sqlite3'));
  const tdb2 = new Database2(path.join(installDir, 'data', 'workspaces', String(wsA), 'websitescout.db'), {
    readonly: true,
  });
  const subTables = tdb2
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%submission%'")
    .all()
    .map((r) => r.name);
  let subCount = 0;
  for (const t of subTables) {
    try {
      subCount += Number(tdb2.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
    } catch {
      /* table without rows */
    }
  }
  tdb2.close();
  check(
    'form submission landed in the clone tenant DB',
    subCount >= 1,
    `tables ${subTables.join(',')} count ${subCount}`
  );
}

async function modeOffContrast() {
  console.log('batch155 part E: mode OFF contrast (same tree, platform behaviour unchanged)');
  const PORT = 43156;
  const child = spawnServer({
    cwd: root,
    port: PORT,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CAPTCHA_OPTIONAL: '1',
      APP_URL: process.env.APP_URL,
      DB_DRIVER: process.env.DB_DRIVER,
      SQLITE_PATH: process.env.SQLITE_PATH,
      MYSQL_DATABASE: process.env.MYSQL_DATABASE,
      // The --mysql runner exports the gate connection as MYSQL_*;
      // forward it or the child defaults to 127.0.0.1:3306 and dies.
      MYSQL_HOST: process.env.MYSQL_HOST,
      MYSQL_PORT: process.env.MYSQL_PORT,
      MYSQL_USER: process.env.MYSQL_USER,
      MYSQL_PASSWORD: process.env.MYSQL_PASSWORD,
      WORKSPACE_DATA_DIR: process.env.WORKSPACE_DATA_DIR,
      EXPORT_ROOT: process.env.EXPORT_ROOT,
      SESSION_SECRET: process.env.SESSION_SECRET,
      SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
    },
  });
  try {
    try {
      await waitForHealth(PORT, child, 'platform');
    } catch (e) {
      check('mode OFF: platform child boots', false, `${e.message} :: LOGS ${child.logs.slice(-900)}`);
      throw e;
    }
    const cfg = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/config`);
    check('mode OFF: staff auth surface answers (not 404)', cfg.status === 200, `status ${cfg.status}`);
    const app = await fetch(`http://127.0.0.1:${PORT}/app`);
    check('mode OFF: staff app page is served', app.status === 200, `status ${app.status}`);
  } finally {
    await stopServer(child);
  }
}

function portalButtonPins() {
  console.log('batch155 part F: portal Download Backup button (spec §9 phase 4)');
  const html = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public/js/portal.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'server/routes/portal.js'), 'utf8');
  check(
    'portal markup carries the backup bar, the Download Backup button and the §7 limitations copy',
    html.includes('id="backup-bar"') &&
      html.includes('id="btn-site-backup"') &&
      html.includes('>Download Backup<') &&
      html.includes('frozen at the moment you download it') &&
      html.includes('your own host') &&
      html.includes('never contacts BitPype')
  );
  check(
    'portal JS wires the button to the standalone-backup endpoint as a blob download',
    js.includes("getElementById('btn-site-backup')") &&
      js.includes("fetch('/api/v1/portal/site/standalone-backup'") &&
      js.includes('URL.createObjectURL(blob)')
  );
  check(
    'backup bar visibility syncs with the site-editable state and hides at the gate',
    js.includes("getElementById('backup-bar')") && js.includes('backupBar.hidden = !(can && !state.editFullscreen)') && js.includes('backupBar.hidden = true')
  );
  check('portal route for the download exists', routes.includes("router.post('/site/standalone-backup'"));
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  check(
    'image build carries the BUILD_SHA provenance stamp (selective COPY — the manifest git sha depends on it)',
    dockerfile.includes('COPY BUILD_SHA* ./')
  );
}

(async () => {
  try {
    const ctx = await main();
    await installerAndClone(ctx);
    portalButtonPins();
    await modeOffContrast();
  } catch (e) {
    failures.push(`suite error: ${e && e.message ? e.message : e}`);
    console.error(e);
  }
  console.log(`\nbatch155: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failures:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  process.exit(0);
})();
