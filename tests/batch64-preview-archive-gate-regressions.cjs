'use strict';
/**
 * Batch 64 — archived-site preview gate.
 *
 * THE BUG (Ely's delete test, 2026-10-29): website.delete soft-archives a
 * site; the public module API answers 410 SITE_ARCHIVED, but the static
 * /site-previews mount kept serving the archived site's full HTML —
 * GET /site-previews/ws-1-site-27-<exportSlug>/index.html returned 200.
 * Root cause: the Batch 27 gate (server/previewSecurity.js
 * blockArchivedPreviews) resolved the site id with end-anchored regexes
 * (-site-(\d+)$), which never match the canonical export folder shape
 * ws-{ws}-site-{id}-{exportSlug} — the gate silently fell through.
 *
 * THE FIX:
 *   - resolvePreviewSite anchors at the folder-name start for the
 *     ws-{ws}-site-{id}(-{slug}) and (qa-)site-{id} shapes, keeps the
 *     legacy {slug}-{id} trailing fallback outside the ws-* namespace
 *     (design-job folders never resolve as websites), and can never
 *     misread sibling ids (site-270 ≠ site 27).
 *   - Archived → 410 with the module API's body
 *     { ok:false, code:'SITE_ARCHIVED', error:'This site is no longer
 *     available' } — for the index AND every sub-path.
 *   - The gate also runs in the Batch 31 themed-404 fallthrough mount,
 *     so a missing file inside an archived folder cannot leak the
 *     site's themed 404 page.
 *   - Unresolvable folders and missing site rows fall through, so a
 *     nonexistent preview still 404s downstream (never 410).
 *   - No authenticated preview of archived sites exists (the portal
 *     resolves only archived_at IS NULL sites; Archives offers Restore
 *     / Purge only) — 410 for everyone, restore-first, is the contract.
 *
 * NEGATIVE PROOF: B64_NEGATIVE=1 loads a mutated copy of
 * previewSecurity.js with the archived branch disabled — the Part B
 * archived checks then fail and this file exits non-zero, proving the
 * branch is the only thing standing between an archived site and its
 * public preview.
 *
 * Harness: unit checks (resolution + gate with a fixture workspace DB)
 * + HTTP checks against the real server booted on temp dirs (batch61
 * pattern). DB_DRIVER=sqlite.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b64-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch64', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const NEGATIVE = process.env.B64_NEGATIVE === '1';
const PORT = 31464;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
    console.log('ok -', name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.error('FAIL -', name, '\n ', e && e.message);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('ok -', name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.error('FAIL -', name, '\n ', e && e.message);
  }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ==================================================================== */
/* Part A — folder → site resolution matrix                             */
/* ==================================================================== */

const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));
const resolve = previewSecurity.resolvePreviewSite;

check('A1: canonical export folder ws-{ws}-site-{id}-{exportSlug} resolves (the leaked shape)', () => {
  assert.deepEqual(resolve('/ws-1-site-27-e2ed807be54c21d091/index.html'), { workspaceId: 1, siteId: 27 });
  assert.deepEqual(resolve('/ws-1-site-27-e2ed807be54c21d091/images/module-x.png'), { workspaceId: 1, siteId: 27 });
});
check('A2: bare ws-{ws}-site-{id} folder resolves; workspace comes from the prefix', () => {
  assert.deepEqual(resolve('/ws-1-site-27/index.html'), { workspaceId: 1, siteId: 27 });
  assert.deepEqual(resolve('/ws-4-site-27/index.html'), { workspaceId: 4, siteId: 27 });
});
check('A3: sibling ids are never misread (site-270 is not site 27)', () => {
  assert.deepEqual(resolve('/ws-1-site-270-e2ed807be54c21d091/index.html'), { workspaceId: 1, siteId: 270 });
  assert.deepEqual(resolve('/ws-12-site-270/index.html'), { workspaceId: 12, siteId: 270 });
  assert.equal(resolve('/ws-1-site-27x/index.html'), null);
});
check('A4: screenshots + QA dirs resolve (site-{id}, qa-site-{id})', () => {
  assert.deepEqual(resolve('/site-27/screenshots/v1/home-desktop.png'), { workspaceId: 1, siteId: 27 });
  assert.deepEqual(resolve('/qa-site-27/index.html'), { workspaceId: 1, siteId: 27 });
});
check('A5: legacy {slug}-{id} folders resolve via the trailing id', () => {
  assert.deepEqual(resolve('/riverside-test-bakery-27/index.html'), { workspaceId: 1, siteId: 27 });
});
check('A6: design-job folders and website-promo assets never resolve as websites', () => {
  assert.equal(resolve('/ws-1-design-23/index.html'), null);
  assert.equal(resolve('/website-promo/ws-1/brochure-1.png'), null);
  assert.equal(resolve('/something-else/'), null);
  assert.equal(resolve('/'), null);
});

/* ==================================================================== */
/* Part B — gate behavior against a fixture workspace DB                */
/* ==================================================================== */

const Database = require('better-sqlite3');
const fixtureDb = new Database(':memory:');
fixtureDb.exec('CREATE TABLE websites (id INTEGER PRIMARY KEY, archived_at TEXT)');
fixtureDb.prepare('INSERT INTO websites (id, archived_at) VALUES (?, ?)').run(9101, '2026-10-29 00:00:00');
fixtureDb.prepare('INSERT INTO websites (id, archived_at) VALUES (?, ?)').run(9102, null);
fixtureDb.prepare('INSERT INTO websites (id, archived_at) VALUES (?, ?)').run(27, '2026-10-29 14:27:51');

const workspaceDb = require(path.join(root, 'server/workspaceDb.js'));
const realOpen = workspaceDb.openWorkspaceDb;
workspaceDb.openWorkspaceDb = () => fixtureDb;

let gate = previewSecurity.blockArchivedPreviews;
if (NEGATIVE) {
  const src = fs.readFileSync(path.join(root, 'server/previewSecurity.js'), 'utf8');
  const mutated = src.replace('if (row && row.archived_at) {', 'if (false) {');
  assert.notEqual(mutated, src, 'negative mutation must apply');
  const tmpFile = path.join(root, 'server/previewSecurity.b64neg.js');
  fs.writeFileSync(tmpFile, mutated);
  try {
    gate = require(tmpFile).blockArchivedPreviews;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function runGate(p) {
  const out = { status: null, body: null, headers: {}, nexted: false };
  gate(
    { path: p },
    {
      status(c) { out.status = c; return this; },
      setHeader(k, v) { out.headers[k] = v; return this; },
      json(o) { out.body = o; return this; },
      send(b) { out.body = b; return this; },
    },
    () => { out.nexted = true; }
  );
  return out;
}

check('B1: archived canonical folder (hash suffix) → 410 with the module-API body', () => {
  const out = runGate('/ws-1-site-9101-b64hash0000000001/index.html');
  assert.equal(out.status, 410);
  assert.deepEqual(out.body, {
    ok: false,
    code: 'SITE_ARCHIVED',
    error: 'This site is no longer available',
  });
});
check('B2: archived gate covers sub-paths (pages + assets), not just index', () => {
  assert.equal(runGate('/ws-1-site-9101-b64hash0000000001/services.html').status, 410);
  assert.equal(runGate('/ws-1-site-9101-b64hash0000000001/images/module-x.png').status, 410);
  assert.equal(runGate('/ws-1-site-9101-b64hash0000000001/').status, 410);
});
check('B3: archived screenshots dir → 410', () => {
  assert.equal(runGate('/site-9101/screenshots/v1/home-desktop.png').status, 410);
  assert.equal(runGate('/site-27/screenshots/v1/home-desktop.png').status, 410);
});
check('B4: live site passes through untouched', () => {
  const out = runGate('/ws-1-site-9102-b64hash0000000002/index.html');
  assert.equal(out.nexted, true);
  assert.equal(out.status, null);
});
check('B5: missing site row falls through (downstream 404 preserved, never 410)', () => {
  assert.equal(runGate('/ws-1-site-9999-b64hash0000000999/index.html').nexted, true);
});
check('B6: design + promo paths fall through', () => {
  assert.equal(runGate('/ws-1-design-23/index.html').nexted, true);
  assert.equal(runGate('/website-promo/ws-1/brochure-1.png').nexted, true);
});
check('B7: archive state is read live — unarchive passes, re-archive 410s', () => {
  fixtureDb.prepare('UPDATE websites SET archived_at = NULL WHERE id = 9101').run();
  assert.equal(runGate('/ws-1-site-9101-b64hash0000000001/index.html').nexted, true);
  fixtureDb.prepare("UPDATE websites SET archived_at = '2026-10-29 01:00:00' WHERE id = 9101").run();
  assert.equal(runGate('/ws-1-site-9101-b64hash0000000001/index.html').status, 410);
});
check('B8: module API archived contract is intact and identical to the gate body', () => {
  const smSrc = fs.readFileSync(path.join(root, 'server/siteModules.js'), 'utf8');
  assert.ok(
    smSrc.includes("fail('SITE_ARCHIVED', 'This site is no longer available', 410)"),
    'siteModules still throws the shared SITE_ARCHIVED 410'
  );
  assert.deepEqual(previewSecurity.SITE_ARCHIVED_BODY, {
    ok: false,
    code: 'SITE_ARCHIVED',
    error: 'This site is no longer available',
  });
});
check('B9: structural pins — gate wired into BOTH /site-previews mounts in server.js', () => {
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const mounts = serverSrc.match(/blockArchivedPreviews/g) || [];
  assert.ok(mounts.length >= 2, `expected >=2 gate references in server.js, found ${mounts.length}`);
});
workspaceDb.openWorkspaceDb = realOpen;

/* ==================================================================== */
/* Part C — HTTP against the booted real server                         */
/* ==================================================================== */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);
const HASH_A = 'b64hash0000000001';
const HASH_L = 'b64hash0000000002';
const HASH_SIB = 'b64hash0000000010';

function writeExport(rel, content) {
  const full = path.join(process.env.EXPORT_ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function partC() {
  // Fixture workspace DB through the app's own workspaceDb (real schema).
  const seed = spawnSync(
    process.execPath,
    [
      '-e',
      `const wsDb = require(process.env.B64_ROOT + '/server/workspaceDb.js');
       const db = wsDb.openWorkspaceDb(1);
       db.prepare("INSERT INTO leads (id, business_name) VALUES (9101, 'B64 Archived'), (9102, 'B64 Live'), (91010, 'B64 Sibling')").run();
       db.prepare("INSERT INTO websites (id, lead_id, name, theme, pages, status, archived_at) VALUES " +
         "(9101, 9101, 'B64 Archived Site', '{}', '[]', 'draft', '2026-10-29 00:00:00'), " +
         "(9102, 9102, 'B64 Live Site', '{}', '[]', 'draft', NULL), " +
         "(91010, 91010, 'B64 Sibling Live Site', '{}', '[]', 'draft', NULL)").run();
       console.log('seeded');`,
    ],
    { env: { ...process.env, B64_ROOT: root }, encoding: 'utf8' }
  );
  assert.equal(seed.status, 0, 'fixture seed failed: ' + seed.stderr + seed.stdout);

  writeExport(`ws-1-site-9101-${HASH_A}/index.html`, '<h1>ARCHIVED INDEX</h1>');
  writeExport(`ws-1-site-9101-${HASH_A}/services.html`, '<h1>ARCHIVED SERVICES</h1>');
  writeExport(`ws-1-site-9101-${HASH_A}/images/pixel.png`, PNG);
  writeExport(`ws-1-site-9101-${HASH_A}/404.html`, '<h1>ARCHIVED THEMED 404</h1>');
  writeExport(`ws-1-site-9102-${HASH_L}/index.html`, '<h1>LIVE INDEX</h1>');
  writeExport(`ws-1-site-9102-${HASH_L}/services.html`, '<h1>LIVE SERVICES</h1>');
  writeExport(`ws-1-site-9102-${HASH_L}/404.html`, '<h1>LIVE THEMED 404</h1>');
  writeExport(`ws-1-site-91010-${HASH_SIB}/index.html`, '<h1>SIBLING LIVE INDEX</h1>');
  writeExport('site-9101/screenshots/v1/home-desktop.png', PNG);
  writeExport('site-9102/screenshots/v1/home-desktop.png', PNG);
  const liveIndexFile = fs.readFileSync(path.join(process.env.EXPORT_ROOT, `ws-1-site-9102-${HASH_L}/index.html`));

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

    const get = (p) => fetch(BASE + p, { redirect: 'manual' });

    await acheck('C1: archived preview index → 410 SITE_ARCHIVED (anonymous)', async () => {
      const res = await get(`/site-previews/ws-1-site-9101-${HASH_A}/index.html`);
      assert.equal(res.status, 410);
      const body = await res.json();
      assert.equal(body.code, 'SITE_ARCHIVED');
      assert.equal(body.error, 'This site is no longer available');
    });
    await acheck('C2: archived preview sub-page + asset + folder root → 410', async () => {
      assert.equal((await get(`/site-previews/ws-1-site-9101-${HASH_A}/services.html`)).status, 410);
      assert.equal((await get(`/site-previews/ws-1-site-9101-${HASH_A}/images/pixel.png`)).status, 410);
      assert.equal((await get(`/site-previews/ws-1-site-9101-${HASH_A}/`)).status, 410);
    });
    await acheck('C3: archived screenshots dir → 410; live screenshots → 200', async () => {
      assert.equal((await get('/site-previews/site-9101/screenshots/v1/home-desktop.png')).status, 410);
      const live = await get('/site-previews/site-9102/screenshots/v1/home-desktop.png');
      assert.equal(live.status, 200);
      assert.equal(sha(Buffer.from(await live.arrayBuffer())), sha(PNG));
    });
    await acheck('C4: live site serves byte-identical content (gate is transparent)', async () => {
      const res = await get(`/site-previews/ws-1-site-9102-${HASH_L}/index.html`);
      assert.equal(res.status, 200);
      assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(liveIndexFile));
      assert.equal((await get(`/site-previews/ws-1-site-9102-${HASH_L}/services.html`)).status, 200);
    });
    await acheck('C5: sibling site (91010) serves while 9101 is archived — no prefix confusion', async () => {
      const res = await get(`/site-previews/ws-1-site-91010-${HASH_SIB}/index.html`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('SIBLING LIVE INDEX'));
    });
    await acheck('C6: nonexistent preview folder → 404, not 410', async () => {
      const res = await get('/site-previews/ws-1-site-9999-b64hash0000000999/index.html');
      assert.equal(res.status, 404);
    });
    await acheck('C7: missing file inside ARCHIVED folder → 410 (themed 404 must not leak)', async () => {
      const res = await get(`/site-previews/ws-1-site-9101-${HASH_A}/nope.html`);
      assert.equal(res.status, 410);
    });
    await acheck('C8: missing file inside LIVE folder → themed 404 preserved (Batch 31)', async () => {
      const res = await get(`/site-previews/ws-1-site-9102-${HASH_L}/nope.html`);
      assert.equal(res.status, 404);
      assert.ok((await res.text()).includes('LIVE THEMED 404'));
    });
    await acheck('C9: unarchive → preview serves again; re-archive → 410 (live DB read)', async () => {
      const wsFile = path.join(process.env.WORKSPACE_DATA_DIR, '1', 'websitescout.db');
      const ext = new Database(wsFile);
      ext.prepare('UPDATE websites SET archived_at = NULL WHERE id = 9101').run();
      const live = await get(`/site-previews/ws-1-site-9101-${HASH_A}/index.html`);
      assert.equal(live.status, 200);
      assert.ok((await live.text()).includes('ARCHIVED INDEX'));
      ext.prepare("UPDATE websites SET archived_at = '2026-10-29 02:00:00' WHERE id = 9101").run();
      assert.equal((await get(`/site-previews/ws-1-site-9101-${HASH_A}/index.html`)).status, 410);
      ext.close();
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

(async () => {
  if (!NEGATIVE) await partC();
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(
    JSON.stringify({
      file: 'batch64-preview-archive-gate-regressions',
      checks: results.length,
      failed: failed.length,
      negative: NEGATIVE,
    })
  );
  if (failed.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
