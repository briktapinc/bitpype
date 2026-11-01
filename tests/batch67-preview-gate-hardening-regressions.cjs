'use strict';
/**
 * Batch 67 — preview gate done right (final-review H-1, H-2, M-1, M-2
 * + the site-28 forensic fix).
 *
 * Batch 64 gated canonical archived preview paths, but the final
 * review verified three escapes and one relocation:
 *   H-1 percent-encoding the folder segment defeated the gate
 *       (req.path is encoded; serve-static decodes).
 *   H-2 `..` traversal from any live folder reached an archived one
 *       (the gate inspected only segment[0]; send normalizes after).
 *   M-1 a site folder with NO websites row served in full (fail-open)
 *       — site 28's orphaned folder, left behind when lead 641's
 *       delete cascaded its row away.
 *   M-2 design-job preview folders relocated the same leak for jobs
 *       linked to archived websites.
 *
 * THE FIX (server/previewSecurity.js):
 *   - every segment is decoded (decodeURIComponent loop until stable;
 *     malformed/never-stable fails CLOSED with the 410 body) before
 *     matching, on both /site-previews mounts;
 *   - any decoded `..` segment is rejected outright (covers %2e%2e
 *     and ..%2f via the decode-first split), and EVERY segment is
 *     re-gated, not just the first;
 *   - a resolved site folder with no row answers 410 when the folder
 *     exists on disk (still falls through when it does not, so
 *     nonexistent previews keep their downstream 404);
 *   - ws-{ws}-design-{jobId} resolves through design_jobs.website_id:
 *     linked to an archived or missing website → 410; a design folder
 *     with no job row → 410 when it exists on disk; unlinked jobs pass.
 *   Storage side: destroyWebsite now removes linked jobs' design
 *   folders on purge (collectSiteExportFolders + designJobIds), and
 *   designPreviewUrl deletes a job's stale design folder once the job
 *   is linked to a website.
 *
 * FORENSIC FIX (src/leadEngine.js deleteLead): the site-28 trace
 * showed deleteLead cascade-deleting an archived site's row with NO
 * activity_log entry and NO export-folder cleanup. deleteLead now
 * writes an activity row naming the website ids that followed the
 * lead, and removes those sites' export folders after the delete.
 *
 * NEGATIVE PROOFS (must exit non-zero):
 *   B67_NEGATIVE=encoding  — the decode step is removed (H-1 returns:
 *     the encoded-archived check B1/C1 fails).
 *   B67_NEGATIVE=traversal — the `..` rejection is removed AND the
 *     gate only inspects the first segment (H-2 returns: B2–B4 fail).
 *
 * Harness: unit checks (decode/analyze + gate vs a fixture DB and a
 * temp export root) + HTTP checks against the real server booted on
 * temp dirs (batch64 pattern; raw http.request for attack paths
 * because fetch/WHATWG-URL normalizes dot segments client-side) +
 * engine checks for the deleteLead/destroyWebsite storage behavior.
 * DB_DRIVER=sqlite.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b67-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch67', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 17).toString('base64');

const NEGATIVE = process.env.B67_NEGATIVE || '';
const PORT = 31467;
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

const previewSecurity = require(path.join(root, 'server/previewSecurity.js'));
const analyze = previewSecurity.analyzePreviewPath;

/* ==================================================================== */
/* Part A — decode + analysis matrix                                    */
/* ==================================================================== */

check('A1: plain path decodes to itself; no traversal', () => {
  const a = analyze('/ws-1-site-27-abc123/index.html');
  assert.equal(a.malformed, false);
  assert.equal(a.traversal, false);
  assert.deepEqual(a.segs, ['ws-1-site-27-abc123', 'index.html']);
});
check('A2: percent-encoded folder segment decodes (H-1 trigger shape)', () => {
  const a = analyze('/ws-1-site-%32%38-bacd14848e95b45d7c/index.html');
  assert.deepEqual(a.segs[0], 'ws-1-site-28-bacd14848e95b45d7c');
  assert.equal(a.traversal, false);
});
check('A3: literal .. is traversal', () => {
  assert.equal(analyze('/ws-1-site-21-x/../ws-1-site-28-y/index.html').traversal, true);
});
check('A4: %2e%2e is traversal after decode', () => {
  assert.equal(analyze('/ws-1-site-21-x/%2e%2e/ws-1-site-28-y/index.html').traversal, true);
});
check('A5: ..%2f is traversal after decode + re-split', () => {
  const a = analyze('/ws-1-site-21-x/..%2fws-1-site-28-y/index.html');
  assert.equal(a.traversal, true);
  assert.ok(a.segs.includes('ws-1-site-28-y'));
});
check('A6: double-encoded dots decode until stable → traversal', () => {
  assert.equal(analyze('/ws-1-site-21-x/%252e%252e/ws-1-site-28-y/').traversal, true);
});
check('A7: malformed encoding is flagged (fail closed)', () => {
  assert.equal(analyze('/ws-1-site-28-x/%zz').malformed, true);
  assert.equal(analyze('/ws-1-site-28-x/%').malformed, true);
});
check('A8: design folders resolve as design targets, never as websites', () => {
  assert.deepEqual(previewSecurity.resolvePreviewDesign('ws-1-design-23'), { workspaceId: 1, jobId: 23 });
  assert.equal(previewSecurity.resolvePreviewSite('/ws-1-design-23/index.html'), null);
});

/* ==================================================================== */
/* Part B — gate behavior vs fixture DB + temp export root              */
/* ==================================================================== */

const Database = require('better-sqlite3');
const fixtureDb = new Database(':memory:');
fixtureDb.exec('CREATE TABLE websites (id INTEGER PRIMARY KEY, archived_at TEXT)');
fixtureDb.exec('CREATE TABLE design_jobs (id INTEGER PRIMARY KEY, website_id INTEGER)');
fixtureDb.prepare('INSERT INTO websites (id, archived_at) VALUES (?, ?)').run(9101, '2026-10-29 00:00:00');
fixtureDb.prepare('INSERT INTO websites (id, archived_at) VALUES (?, ?)').run(9102, null);
fixtureDb.prepare('INSERT INTO design_jobs (id, website_id) VALUES (?, ?)').run(8101, 9101); // → archived
fixtureDb.prepare('INSERT INTO design_jobs (id, website_id) VALUES (?, ?)').run(8102, 9102); // → live
fixtureDb.prepare('INSERT INTO design_jobs (id, website_id) VALUES (?, ?)').run(8103, null); // unlinked
fixtureDb.prepare('INSERT INTO design_jobs (id, website_id) VALUES (?, ?)').run(8104, 9997); // → missing site

function mkFolder(name) {
  fs.mkdirSync(path.join(process.env.EXPORT_ROOT, name), { recursive: true });
}
mkFolder('ws-1-site-9309-b67orphan'); // no websites row
mkFolder('ws-1-design-9309'); // no design_jobs row

const workspaceDb = require(path.join(root, 'server/workspaceDb.js'));
const realOpen = workspaceDb.openWorkspaceDb;
workspaceDb.openWorkspaceDb = () => fixtureDb;

let gate = previewSecurity.blockArchivedPreviews;
if (NEGATIVE) {
  const src = fs.readFileSync(path.join(root, 'server/previewSecurity.js'), 'utf8');
  let mutated = src;
  if (NEGATIVE === 'encoding') {
    mutated = mutated.replace('const dec = decodeSegmentStable(raw);', 'const dec = raw;');
  } else if (NEGATIVE === 'traversal') {
    mutated = mutated
      .replace('if (analysis.malformed || analysis.traversal) {', 'if (analysis.malformed) {')
      .replace('for (const seg of analysis.segs) {', "for (const seg of [analysis.segs[0] || '']) {");
  }
  assert.notEqual(mutated, src, `negative mutation (${NEGATIVE}) must apply`);
  const tmpFile = path.join(root, 'server/previewSecurity.b67neg.js');
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

check('B1 (a): percent-encoded ARCHIVED folder → 410 (H-1)', () => {
  const out = runGate('/ws-1-site-%39%31%30%31-b67hash/index.html');
  assert.equal(out.status, 410);
  assert.equal(out.body && out.body.code, 'SITE_ARCHIVED');
});
check('B2 (b): traversal from a LIVE folder into the archived one → 410 (H-2)', () => {
  assert.equal(runGate('/ws-1-site-9102-b67live/../ws-1-site-9101-b67hash/index.html').status, 410);
});
check('B3 (b): %2e%2e traversal → 410', () => {
  assert.equal(runGate('/ws-1-site-9102-b67live/%2e%2e/ws-1-site-9101-b67hash/index.html').status, 410);
});
check('B4 (b): ..%2f traversal → 410', () => {
  assert.equal(runGate('/ws-1-site-9102-b67live/..%2fws-1-site-9101-b67hash/index.html').status, 410);
});
check('B5 (c): site folder with NO row but present on disk → 410 (M-1 fail-closed)', () => {
  assert.equal(runGate('/ws-1-site-9309-b67orphan/index.html').status, 410);
});
check('B6 (c): site folder with NO row and NOT on disk → falls through (404 preserved)', () => {
  assert.equal(runGate('/ws-1-site-9310-b67nofolder/index.html').nexted, true);
});
check('B7 (d): canonical archived path → 410 with the exact module-API body', () => {
  const out = runGate('/ws-1-site-9101-b67hash/index.html');
  assert.equal(out.status, 410);
  assert.deepEqual(out.body, {
    ok: false,
    code: 'SITE_ARCHIVED',
    error: 'This site is no longer available',
  });
});
check('B8 (e): live site passes through', () => {
  const out = runGate('/ws-1-site-9102-b67live/index.html');
  assert.equal(out.nexted, true);
  assert.equal(out.status, null);
});
check('B9 (f): design folder of a job linked to an ARCHIVED site → 410 (M-2)', () => {
  assert.equal(runGate('/ws-1-design-8101/index.html').status, 410);
});
check('B10 (f): design folder of a job linked to a MISSING site → 410', () => {
  assert.equal(runGate('/ws-1-design-8104/index.html').status, 410);
});
check('B11 (f): design folder of an UNLINKED job passes (deliberate job artifact)', () => {
  assert.equal(runGate('/ws-1-design-8103/index.html').nexted, true);
});
check('B12 (f): design folder of a job linked to a LIVE site passes', () => {
  assert.equal(runGate('/ws-1-design-8102/index.html').nexted, true);
});
check('B13 (f): design folder with NO job row but present on disk → 410', () => {
  assert.equal(runGate('/ws-1-design-9309/index.html').status, 410);
});
check('B14 (f): design folder with NO job row and NOT on disk → falls through', () => {
  assert.equal(runGate('/ws-1-design-9310/index.html').nexted, true);
});
check('B15: malformed encoding anywhere in the path → 410 (fail closed)', () => {
  assert.equal(runGate('/ws-1-site-9102-b67live/%zz').status, 410);
});
check('B16: encoded traversal into a LIVE sibling still 410s at the gate (archived target deeper in path)', () => {
  assert.equal(runGate('/ws-1-site-9102-b67live/sub/%2e%2e/%2e%2e/ws-1-site-9101-b67hash/').status, 410);
});
workspaceDb.openWorkspaceDb = realOpen;

/* ==================================================================== */
/* Part C — HTTP against the booted real server                         */
/* ==================================================================== */

const HASH_A = 'b67hash00000000001';
const HASH_L = 'b67hash00000000002';
const HASH_O = 'b67hash00000000009';

function writeExport(rel, content) {
  const full = path.join(process.env.EXPORT_ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function rawGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function partC() {
  const seed = spawnSync(
    process.execPath,
    [
      '-e',
      `const wsDb = require(process.env.B67_ROOT + '/server/workspaceDb.js');
       const db = wsDb.openWorkspaceDb(1);
       db.prepare("INSERT INTO leads (id, business_name) VALUES (9201, 'B67 Archived'), (9202, 'B67 Live')").run();
       db.prepare("INSERT INTO websites (id, lead_id, name, theme, pages, status, archived_at) VALUES " +
         "(9201, 9201, 'B67 Archived Site', '{}', '[]', 'draft', '2026-10-29 00:00:00'), " +
         "(9202, 9202, 'B67 Live Site', '{}', '[]', 'draft', NULL)").run();
       db.prepare("INSERT INTO design_jobs (type, title, instructions, lead_id, status, website_id) VALUES " +
         "('website', 'B67 job archived', 'x', 9201, 'delivered', 9201), " +
         "('website', 'B67 job live', 'x', 9202, 'delivered', 9202), " +
         "('website', 'B67 job unlinked', 'x', 9202, 'delivered', NULL), " +
         "('website', 'B67 job missing site', 'x', 9202, 'delivered', 9298)").run();
       console.log('seeded');`,
    ],
    { env: { ...process.env, B67_ROOT: root }, encoding: 'utf8' }
  );
  assert.equal(seed.status, 0, 'fixture seed failed: ' + seed.stderr + seed.stdout);
  // design job ids are autoincrement on a fresh DB: 1..4 in insert order.
  writeExport(`ws-1-site-9201-${HASH_A}/index.html`, '<h1>B67 ARCHIVED INDEX</h1>');
  writeExport(`ws-1-site-9201-${HASH_A}/services.html`, '<h1>B67 ARCHIVED SERVICES</h1>');
  writeExport(`ws-1-site-9201-${HASH_A}/404.html`, '<h1>B67 ARCHIVED THEMED 404</h1>');
  writeExport(`ws-1-site-9202-${HASH_L}/index.html`, '<h1>B67 LIVE INDEX</h1>');
  writeExport(`ws-1-site-9202-${HASH_L}/services.html`, '<h1>B67 LIVE SERVICES</h1>');
  writeExport(`ws-1-site-9299-${HASH_O}/index.html`, '<h1>B67 ORPHAN INDEX</h1>');
  writeExport('ws-1-design-1/index.html', '<h1>B67 DESIGN FOR ARCHIVED SITE</h1>');
  writeExport('ws-1-design-2/index.html', '<h1>B67 DESIGN FOR LIVE SITE</h1>');
  writeExport('ws-1-design-3/index.html', '<h1>B67 DESIGN UNLINKED JOB</h1>');
  writeExport('ws-1-design-4/index.html', '<h1>B67 DESIGN FOR MISSING SITE</h1>');
  writeExport('ws-1-design-9299/index.html', '<h1>B67 DESIGN NO JOB ROW</h1>');
  const liveIndexFile = fs.readFileSync(path.join(process.env.EXPORT_ROOT, `ws-1-site-9202-${HASH_L}/index.html`));

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

    await acheck('C1 (a): HTTP percent-encoded archived folder → 410 SITE_ARCHIVED', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-%39%32%30%31-${HASH_A}/index.html`);
      assert.equal(res.status, 410);
      assert.equal(JSON.parse(res.body).code, 'SITE_ARCHIVED');
    });
    await acheck('C2 (b): HTTP plain .. traversal from live folder → 410 (never archived bytes)', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-9202-${HASH_L}/../ws-1-site-9201-${HASH_A}/index.html`);
      assert.equal(res.status, 410);
      assert.ok(!res.body.includes('B67 ARCHIVED INDEX'));
    });
    await acheck('C3 (b): HTTP %2e%2e traversal → 410', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-9202-${HASH_L}/%2e%2e/ws-1-site-9201-${HASH_A}/index.html`);
      assert.equal(res.status, 410);
      assert.ok(!res.body.includes('B67 ARCHIVED INDEX'));
    });
    await acheck('C4 (b): HTTP ..%2f traversal → 410', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-9202-${HASH_L}/..%2fws-1-site-9201-${HASH_A}/index.html`);
      assert.equal(res.status, 410);
      assert.ok(!res.body.includes('B67 ARCHIVED INDEX'));
    });
    await acheck('C5 (c): HTTP orphan folder (no row, on disk) → 410', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-9299-${HASH_O}/index.html`);
      assert.equal(res.status, 410);
      assert.ok(!res.body.includes('B67 ORPHAN INDEX'));
    });
    await acheck('C6 (d): HTTP canonical archived → 410 with the exact body', async () => {
      const res = await fetch(`${BASE}/site-previews/ws-1-site-9201-${HASH_A}/index.html`, { redirect: 'manual' });
      assert.equal(res.status, 410);
      const body = await res.json();
      assert.deepEqual(body, {
        ok: false,
        code: 'SITE_ARCHIVED',
        error: 'This site is no longer available',
      });
    });
    await acheck('C7 (e): HTTP live site serves byte-identical index + subpage', async () => {
      const res = await fetch(`${BASE}/site-previews/ws-1-site-9202-${HASH_L}/index.html`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(liveIndexFile));
      const sub = await fetch(`${BASE}/site-previews/ws-1-site-9202-${HASH_L}/services.html`, { redirect: 'manual' });
      assert.equal(sub.status, 200);
    });
    await acheck('C8 (f): HTTP design previews — archived/missing linked → 410; live linked + unlinked → 200; no-row folder → 410', async () => {
      assert.equal((await rawGet('/site-previews/ws-1-design-1/index.html')).status, 410);
      assert.equal((await rawGet('/site-previews/ws-1-design-4/index.html')).status, 410);
      const liveLinked = await rawGet('/site-previews/ws-1-design-2/index.html');
      assert.equal(liveLinked.status, 200);
      assert.ok(liveLinked.body.includes('B67 DESIGN FOR LIVE SITE'));
      const unlinked = await rawGet('/site-previews/ws-1-design-3/index.html');
      assert.equal(unlinked.status, 200);
      assert.ok(unlinked.body.includes('B67 DESIGN UNLINKED JOB'));
      assert.equal((await rawGet('/site-previews/ws-1-design-9299/index.html')).status, 410);
    });
    await acheck('C9: HTTP nonexistent folder (no row, not on disk) → 404, not 410', async () => {
      const res = await fetch(`${BASE}/site-previews/ws-1-site-9998-b67hash0000000998/index.html`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    });
    await acheck('C10: HTTP encoded missing file inside archived folder → 410 (themed 404 cannot leak)', async () => {
      const res = await rawGet(`/site-previews/ws-1-site-%39%32%30%31-${HASH_A}/nope.html`);
      assert.equal(res.status, 410);
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

/* ==================================================================== */
/* Part D — engine behavior: deleteLead + destroyWebsite storage        */
/* ==================================================================== */

function partD() {
  const websiteEngine = require(path.join(root, 'src/websiteEngine.js'));
  const leadEngine = require(path.join(root, 'src/leadEngine.js'));
  const contactForms = require(path.join(root, 'server/contactForms.js'));
  function makeDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
    websiteEngine.ensureTables(db);
    require(path.join(root, 'src/cfDomains.js')).ensureTables(db);
    require(path.join(root, 'src/designJobs.js')).ensureTables(db);
    contactForms.ensureTables(db);
    require(path.join(root, 'server/siteModules.js')).ensureTables(db);
    return db;
  }
  function addLead(db, id) {
    db.prepare(
      `INSERT INTO leads (id, business_name, category, phone, email, city, state)
       VALUES (?, ?, 'Services', '(610) 555-0100', ?, 'Reading', 'PA')`
    ).run(id, `Biz ${id}`, `biz${id}@example.com`);
  }
  function addSite(db, id, leadId, name) {
    db.prepare(
      `INSERT INTO websites (id, lead_id, name, industry, theme, pages, status, preview_url, updated_at)
       VALUES (?, ?, ?, 'services', '{}', '[]', 'draft', NULL, '2026-10-01 00:00:00')`
    ).run(id, leadId, name);
  }

  check('D1: deleteLead on a lead with an ARCHIVED site — row follows, activity is written, export folder is removed', () => {
    const db = makeDb();
    addLead(db, 9301);
    addSite(db, 9301, 9301, 'B67 Lead Fixture');
    websiteEngine.deleteWebsite(db, 9301); // archive it (the site-28 posture)
    db.prepare('INSERT INTO contact_forms (lead_id) VALUES (?)').run(9301);
    const folder = path.join(process.env.EXPORT_ROOT, 'ws-1-site-9301-b67hash');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>orphan-to-be</h1>');

    const out = leadEngine.deleteLead(db, 9301);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM leads WHERE id = 9301').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM websites WHERE id = 9301').get().c, 0, 'site row follows the lead (cascade)');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM contact_forms WHERE lead_id = 9301').get().c, 0);
    const act = db
      .prepare("SELECT message FROM activity_log WHERE area = 'leads' AND message LIKE '%Lead #9301%'")
      .get();
    assert.ok(act, 'deleteLead must write an activity_log row');
    assert.ok(act.message.includes('9301'), 'activity row names the website id(s) that followed');
    assert.equal(fs.existsSync(folder), false, 'export folder must be removed with the lead');
    assert.ok(out.removedExportFolders >= 1, 'result reports the removed folder count');
  });

  check('D2: destroyWebsite (purge) removes the linked design job preview folder too (M-2)', () => {
    const db = makeDb();
    addLead(db, 9302);
    addSite(db, 9302, 9302, 'B67 Purge Fixture');
    const job = db
      .prepare(
        `INSERT INTO design_jobs (type, title, instructions, lead_id, status, website_id)
         VALUES ('website', 'B67 purge job', 'x', 9302, 'delivered', 9302)`
      )
      .run();
    const jobId = Number(job.lastInsertRowid);
    const siteFolder = path.join(process.env.EXPORT_ROOT, 'ws-1-site-9302-b67hash');
    const designFolder = path.join(process.env.EXPORT_ROOT, `ws-1-design-${jobId}`);
    for (const f of [siteFolder, designFolder]) {
      fs.mkdirSync(f, { recursive: true });
      fs.writeFileSync(path.join(f, 'index.html'), '<h1>x</h1>');
    }
    websiteEngine.destroyWebsite(db, 9302, { workspaceId: 1 });
    assert.equal(fs.existsSync(siteFolder), false, 'site folder removed');
    assert.equal(fs.existsSync(designFolder), false, 'design folder removed on purge');
    const row = db.prepare('SELECT website_id FROM design_jobs WHERE id = ?').get(jobId);
    assert.equal(row.website_id, null, 'job is unlinked by purge (its lifecycle continues)');
  });
}

(async () => {
  if (!NEGATIVE) {
    await partC();
    partD();
  }
  const failed = results.filter(([s]) => s === 'FAIL');
  console.log(
    JSON.stringify({
      file: 'batch67-preview-gate-hardening-regressions',
      checks: results.length,
      failed: failed.length,
      negative: NEGATIVE || false,
    })
  );
  if (failed.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
