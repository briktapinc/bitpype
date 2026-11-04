'use strict';
/**
 * Batch 132 — PHOTO CAPTURE FILE LIFECYCLE FIXES (post-deploy bug
 * hunt on Batches 125 + 130, Ely's order 2026-11-04: "Look for bugs
 * after that deploy and fix them").
 *
 * Three defects found live on production, fixed here:
 *   1. ORPHANED UPLOADS — the public submit route stored the photo
 *      through the module-asset pipeline BEFORE the visitor's fields
 *      were validated (validation lived in createPhotoSubmission,
 *      after storage). Every refused submission (missing name, no
 *      email/phone, bad email) left an unreferenced module-* file in
 *      the site's export. Fix: the route runs the ONE shared
 *      validator (siteModules.validatePhotoSubmissionFields) before
 *      storing anything.
 *   2. DELETE LEFT THE FILE SERVED — deletePhotoSubmission removed
 *      the row, its LeadScout event and its category assignments,
 *      but the photo file stayed in the export at its public URL:
 *      an owner's delete did not take the photo down. Fix: the
 *      delete (and the module purge) also removes the stored file —
 *      pipeline-minted module assets only, and never a photo that
 *      was pushed into a gallery (that copy is the gallery's own).
 *   3. WRONG ERROR FOR CORRUPT UPLOADS — applyModuleAssetUpload's
 *      size check conflated an empty decode (malformed base64) with
 *      oversize, telling visitors their corrupt photo was "too
 *      large". Fix: empty decode -> INVALID_IMAGE 'Invalid image
 *      data'; the oversize branch is unchanged.
 *
 *   Part 1 — source pins for all three fixes.
 *   Part 2 — engine (in-process): validator matrix, upload error
 *     codes, delete/purge file behavior incl. the gallery guard and
 *     the module-asset name guard.
 *   Part 3 — HTTP over the real server: refused submissions store
 *     NOTHING (file count unchanged), a valid one stores exactly
 *     one file, a corrupt payload gets the corrected message.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b132-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch132', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const PORT = 31492;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const LEAD_A = 13201;
let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const pub = read('server/routes/modulesPublic.js');
    const routeStart = pub.indexOf("router.post('/:token/photocapture'");
    assert.ok(routeStart > 0, 'photocapture submit route exists');
    const route = pub.slice(routeStart, pub.indexOf('router.', routeStart + 10));
    const vIdx = route.indexOf('validatePhotoSubmissionFields(body)');
    const uIdx = route.indexOf('applyModuleAssetUpload');
    assert.ok(vIdx > 0, 'the submit route validates the visitor fields');
    assert.ok(uIdx > 0 && vIdx < uIdx, 'validation runs BEFORE the photo is stored');
    n += 3;

    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes('function validatePhotoSubmissionFields'), 'the shared validator exists');
    assert.ok(smSrc.includes('validatePhotoSubmissionFields,'), 'the validator is exported for the route');
    const create = smSrc.slice(
      smSrc.indexOf('function createPhotoSubmission'),
      smSrc.indexOf('function getPhotoSubmission')
    );
    assert.ok(
      create.includes('validatePhotoSubmissionFields(data)'),
      'createPhotoSubmission enforces the same validator'
    );
    n += 3;

    const del = smSrc.slice(
      smSrc.indexOf('function deletePhotoSubmission'),
      smSrc.indexOf('function addPhotoSubmissionToGallery')
    );
    assert.ok(del.includes('removeStoredPhotoFile'), 'the per-record delete removes the stored file');
    assert.ok(del.includes('gallery_image_id'), 'a gallery-pushed photo keeps its file on delete');
    const purge = smSrc.slice(smSrc.indexOf("if (type === 'photocapture') {"), smSrc.indexOf('const purged = {}'));
    assert.ok(purge.includes('removeStoredPhotoFile'), 'the module purge removes stored files too');
    const helper = smSrc.slice(
      smSrc.indexOf('function removeStoredPhotoFile'),
      smSrc.indexOf('function deletePhotoSubmission')
    );
    assert.ok(helper.includes('images\\/module-'), 'file removal is fenced to pipeline-minted module assets');
    n += 4;

    const edits = read('server/portalSiteEdits.js');
    const upload = edits.slice(
      edits.indexOf('async function applyModuleAssetUpload'),
      edits.indexOf('async function generateClientSiteImage')
    );
    const emptyIdx = upload.indexOf('if (!buffer.length)');
    const largeIdx = upload.indexOf("code: 'TOO_LARGE'");
    assert.ok(emptyIdx > 0 && largeIdx > emptyIdx, 'the empty-decode check precedes the oversize check');
    assert.ok(
      upload.slice(emptyIdx, largeIdx).includes("'Invalid image data'"),
      'empty decode reads as invalid, not large'
    );
    n += 2;
    group('Part 1 surface pins', n);
  }

  /* ================================================================== */
  /* Part 2 — engine (in-process)                                        */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const sm = require(path.join(root, 'server/siteModules.js'));
  const domain = require(path.join(root, 'server/domain.js'));
  const edits = require(path.join(root, 'server/portalSiteEdits.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a132@example.invalid',
    password: ['batch132', 'fixture', 'password'].join('-'),
    name: 'A132',
    workspaceName: 'Batch132 WS',
  });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B132 Fixture',
    'alpha132@example.invalid',
    'customer'
  );
  db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
    LEAD_A,
    'B132 Fixture Site',
    '{}',
    JSON.stringify([{ slug: 'home', title: 'Home', html: '<p>hi</p>' }]),
    'draft'
  );
  const embA = sm.ensureEmbed(db, LEAD_A, 'photocapture', { workspaceId: WS_ID });
  db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA.id);
  sm.ensureEmbed(db, LEAD_A, 'gallery', { workspaceId: WS_ID });
  const album = sm.createAlbum(db, LEAD_A, { title: 'Fixture Album', status: 'published', images: [] });

  const siteRow = db.prepare('SELECT * FROM websites WHERE lead_id = ? ORDER BY id DESC').get(LEAD_A);
  const folder = domain.resolveSiteExportFolder(WS_ID, siteRow, db);
  const imgDir = path.join(process.env.EXPORT_ROOT, folder, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const plant = (name) => {
    fs.writeFileSync(path.join(imgDir, name), Buffer.from(PNG_1PX.split(',')[1], 'base64'));
    return `images/${name}`;
  };
  const moduleFiles = () => fs.readdirSync(imgDir).filter((f) => f.startsWith('module-'));

  {
    let n = 0;
    // Validator matrix — the exact rules the route now runs pre-storage.
    assert.throws(() => sm.validatePhotoSubmissionFields({ email: 'x@example.invalid' }), /name is required/i);
    assert.throws(() => sm.validatePhotoSubmissionFields({ name: 'X' }), /email address or a phone/i);
    assert.throws(() => sm.validatePhotoSubmissionFields({ name: 'X', email: 'nope' }), /valid email/i);
    sm.validatePhotoSubmissionFields({ name: 'X', email: 'x@example.invalid' });
    sm.validatePhotoSubmissionFields({ name: 'X', phone: '+15550132001' });
    n += 5;

    // Upload error codes: corrupt -> INVALID_IMAGE with the corrected
    // message; genuinely oversize -> TOO_LARGE unchanged.
    await assert.rejects(
      edits.applyModuleAssetUpload(WS_ID, LEAD_A, { data: '###%%%^^^', mimeType: 'image/png' }),
      (e) => e.code === 'INVALID_IMAGE' && /Invalid image data/.test(e.message),
      'malformed base64 is INVALID_IMAGE, not TOO_LARGE'
    );
    n++;
    const bigBuf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(Math.round(5.6 * 1024 * 1024), 7),
    ]);
    await assert.rejects(
      edits.applyModuleAssetUpload(WS_ID, LEAD_A, { data: bigBuf.toString('base64'), mimeType: 'image/png' }),
      (e) => e.code === 'TOO_LARGE',
      'oversize still TOO_LARGE'
    );
    n++;

    // Delete removes the stored file.
    const src1 = plant('module-del1.png');
    const sub1 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Del One',
      email: 'del1@example.invalid',
      image_url: src1,
      image_src: src1,
    });
    assert.ok(fs.existsSync(path.join(imgDir, 'module-del1.png')), 'planted file exists before delete');
    sm.deletePhotoSubmission(db, LEAD_A, sub1.id);
    assert.ok(!fs.existsSync(path.join(imgDir, 'module-del1.png')), 'delete removed the stored photo file');
    n += 2;

    // A gallery-pushed photo keeps its file when the submission goes.
    const src2 = plant('module-del2.png');
    const sub2 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Del Two',
      email: 'del2@example.invalid',
      image_url: src2,
      image_src: src2,
    });
    sm.updatePhotoSubmissionStatus(db, LEAD_A, sub2.id, 'approved');
    sm.addPhotoSubmissionToGallery(db, LEAD_A, sub2.id, album.id);
    sm.deletePhotoSubmission(db, LEAD_A, sub2.id);
    assert.ok(
      fs.existsSync(path.join(imgDir, 'module-del2.png')),
      'gallery-pushed photo file survives the submission delete'
    );
    n++;

    // External URLs and non-module assets are never touched.
    const sub3 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Del Three',
      email: 'del3@example.invalid',
      image_url: 'https://img.example/x.jpg',
      image_src: 'https://img.example/x.jpg',
    });
    sm.deletePhotoSubmission(db, LEAD_A, sub3.id);
    plant('logo.png');
    const sub4 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Del Four',
      email: 'del4@example.invalid',
      image_url: 'images/logo.png',
      image_src: 'images/logo.png',
    });
    sm.deletePhotoSubmission(db, LEAD_A, sub4.id);
    assert.ok(fs.existsSync(path.join(imgDir, 'logo.png')), 'a non-module asset is never unlinked by a photo delete');
    n += 2;
    group('Part 2 engine: validator + upload errors + delete-file', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
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
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      const pub = `${BASE}/api/v1/modules/public/${embA.public_token}/photocapture`;
      const post = (body) =>
        fetch(pub, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const before = moduleFiles().length;

      const noName = await post({ email: 'http1@example.invalid', image: PNG_1PX });
      const noNameJ = await json(noName);
      assert.equal(noName.status, 400, 'missing name refused');
      assert.ok(/name is required/i.test(String(noNameJ.error || '')), 'missing-name message unchanged');
      assert.equal(moduleFiles().length, before, 'a refused submission stores NO file (missing name)');
      n += 3;

      const noId = await post({ name: 'Http Two', image: PNG_1PX });
      assert.equal(noId.status, 400, 'missing identity refused');
      assert.equal(moduleFiles().length, before, 'a refused submission stores NO file (no identity)');
      n += 2;

      const badEmail = await post({ name: 'Http Three', email: 'nope', image: PNG_1PX });
      assert.equal(badEmail.status, 400, 'bad email refused');
      assert.equal(moduleFiles().length, before, 'a refused submission stores NO file (bad email)');
      n += 2;

      const corrupt = await post({ name: 'Http Four', email: 'http4@example.invalid', image: '###%%%^^^' });
      const corruptJ = await json(corrupt);
      assert.equal(corrupt.status, 400, 'corrupt payload refused');
      assert.ok(
        /Invalid image data/i.test(String(corruptJ.error || '')),
        `corrupt payload message corrected (got: ${corruptJ.error})`
      );
      assert.equal(moduleFiles().length, before, 'a corrupt payload stores NO file');
      n += 3;

      const good = await post({ name: 'Http Five', email: 'http5@example.invalid', image: PNG_1PX });
      assert.equal(good.status, 200, 'valid submission accepted');
      assert.equal(moduleFiles().length, before + 1, 'a valid submission stores exactly one file');
      const row = db
        .prepare("SELECT * FROM photocapture_submissions WHERE lead_id = ? AND email = 'http5@example.invalid'")
        .get(LEAD_A);
      assert.ok(row && row.status === 'pending', 'the HTTP submission landed pending');
      n += 3;
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
    group('Part 3 HTTP: refused submissions store nothing', n);
  }

  /* ================================================================== */
  /* Part 4 — module purge removes stored files                          */
  /* ================================================================== */
  {
    let n = 0;
    const srcA = plant('module-purge1.png');
    sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Purge One',
      email: 'pg1@example.invalid',
      image_url: srcA,
      image_src: srcA,
    });
    const srcB = plant('module-purge2.png');
    const subB = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Purge Two',
      email: 'pg2@example.invalid',
      image_url: srcB,
      image_src: srcB,
    });
    sm.updatePhotoSubmissionStatus(db, LEAD_A, subB.id, 'approved');
    sm.addPhotoSubmissionToGallery(db, LEAD_A, subB.id, album.id);
    sm.deleteModule(db, LEAD_A, 'photocapture');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM photocapture_submissions WHERE lead_id = ?').get(LEAD_A).c,
      0,
      'purge removed the submission rows'
    );
    assert.ok(!fs.existsSync(path.join(imgDir, 'module-purge1.png')), 'purge removed the stored file');
    assert.ok(fs.existsSync(path.join(imgDir, 'module-purge2.png')), 'purge kept the gallery-pushed photo file');
    n += 3;
    group('Part 4 module purge file sweep', n);
  }

  console.log(`\nBATCH132 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH132 FAIL:', (e && e.stack) || e);
  process.exit(1);
});
