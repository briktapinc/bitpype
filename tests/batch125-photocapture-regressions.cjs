'use strict';
/**
 * Batch 125 — PHOTO CAPTURE MODULE (Ely's order 2026-11-03, with his
 * standing interdependence rule restated for it: "they should be
 * able to work with all other modules").
 *
 * What is pinned here:
 *   Part 1 — surface pins: the 24th module type + META + embed script
 *     bump; the Batch 122 parity pin extended — photocapture is a
 *     shared-layer PROVIDER (approved submissions only); agent fences
 *     (reads read-only, config/moderation/gallery-push design-write,
 *     moderation + gallery push refresh the preview); MCP catalog +
 *     defs + gate + dispatch + local parity for the five
 *     photocapture.* tools; public + portal routes; portal pane,
 *     embed renderer (camera capture + upload fallback), census line,
 *     legal clauses, and the JSON body-limit allowance that makes a
 *     base64 photo reachable at all.
 *   Part 2 — engine (in-process): config defaults + roundtrip;
 *     dormant-empty payload; submission validation; LeadScout
 *     capture (deduped contact, one 'photo' event per submission,
 *     capture-health clean); moderation state machine (pending
 *     invisible everywhere public, approved visible via the shared
 *     layer + the public grid, rejected invisible, re-approve a
 *     rejected photo allowed); add-to-gallery through the gallery's
 *     own write function (real gallery_images row, idempotent);
 *     strict lead isolation on every read/write; per-record delete
 *     unlinks the LeadScout event; module purge counts.
 *   Part 3 — HTTP over the real server: a phone-camera-style
 *     submission (base64 data URL) lands through the module-asset
 *     pipeline; a non-image is refused; an oversize photo is refused;
 *     the response is state-blind (the configured thanks, no status);
 *     the portal inbox lists, approves and gallery-pushes over HTTP;
 *     the public payload then serves the approved photo; anonymous
 *     portal access is refused.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b125-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch125', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 21).toString('base64');

const PORT = 31485;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = ['batch125', 'fixture', 'password'].join('-');

// 1x1 transparent PNG — a valid image the pipeline sniffs as PNG.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function makeJar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
  };
}
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const LEAD_A = 12501;
const LEAD_B = 12502;
let WS_ID;
let db;

(async () => {
  /* ================================================================== */
  /* Part 1 — surface pins                                               */
  /* ================================================================== */
  {
    let n = 0;
    const share = require(path.join(root, 'server/moduleShare.js'));
    const sm = require(path.join(root, 'server/siteModules.js'));

    assert.ok(sm.MODULE_TYPES.includes('photocapture'), 'photocapture is a module type');
    assert.equal(
      sm.MODULE_TYPES.length,
      28,
      '28 module types (Batch 124 categories + Batch 125 photocapture + Batch 126 finisher qrcode + Batch 128 checkout + Batch 131 comments)'
    );
    assert.equal(sm.MODULE_META.photocapture.label, 'Photo Capture');
    assert.equal(
      sm.MODULE_SCRIPT_VER,
      'mod38',
      'embed script version bumped for the capture renderer (Batch 127 finisher rotation)'
    );
    n += 4;

    // The Batch 122 parity pin, extended: registry ⇔ MODULE_TYPES.
    assert.deepEqual(
      Object.keys(share.SHARE_REGISTRY).sort(),
      [...sm.MODULE_TYPES].sort(),
      'share registry covers every module type exactly'
    );
    n++;
    const entry = share.SHARE_REGISTRY.photocapture;
    assert.equal(entry.kind, 'provider', 'photocapture is a shared-layer provider');
    assert.equal(typeof entry.read, 'function', 'photocapture provider has a reader');
    const providers = sm.MODULE_TYPES.filter((t) => share.SHARE_REGISTRY[t].kind === 'provider');
    assert.equal(
      providers.length,
      19,
      '19 providers after categories (Batch 124) + photocapture + qrcode (Batch 126 finisher)'
    );
    n += 3;

    for (const fn of [
      'getPhotoCaptureConfig',
      'updatePhotoCaptureConfig',
      'createPhotoSubmission',
      'getPhotoSubmission',
      'listPhotoSubmissions',
      'countPhotoSubmissions',
      'updatePhotoSubmissionStatus',
      'deletePhotoSubmission',
      'addPhotoSubmissionToGallery',
      'photoCapturePublicPayload',
      'createPublicPhotoSubmissionByToken',
    ]) {
      assert.equal(typeof sm[fn], 'function', `siteModules exports ${fn}`);
      n++;
    }
    const pc = require(path.join(root, 'server/portalContacts.js'));
    assert.equal(typeof pc.captureFromPhoto, 'function', 'portalContacts exports captureFromPhoto');
    n++;

    // Agent fences.
    const tools = require(path.join(root, 'server/museAgentTools.js'));
    for (const t of ['photocapture.getConfig', 'photocapture.listSubmissions']) {
      assert.ok(tools.PORTAL_READONLY_TOOLS.has(t), `${t} is a portal read tool`);
      n++;
    }
    for (const t of ['photocapture.updateConfig', 'photocapture.moderateSubmission', 'photocapture.addToGallery']) {
      assert.ok(tools.PORTAL_DESIGN_WRITE_TOOLS.has(t), `${t} is a design write tool`);
      n++;
    }
    for (const t of ['photocapture.moderateSubmission', 'photocapture.addToGallery']) {
      assert.ok(tools.PORTAL_MUTATE_TOOLS.has(t), `${t} refreshes the preview after mutation`);
      n++;
    }
    assert.equal(tools.portalModeAllowsTool('answer', 'photocapture.listSubmissions'), true, 'answer mode may list');
    assert.equal(
      tools.portalModeAllowsTool('answer', 'photocapture.moderateSubmission'),
      false,
      'answer mode may NOT moderate'
    );
    assert.equal(
      tools.portalModeAllowsTool('build', 'photocapture.moderateSubmission'),
      true,
      'build mode may moderate'
    );
    n += 3;

    // MCP catalogs + dispatch.
    const catalog = read('src/mcpCatalog.js');
    const mcpSrc = read('server/mcp.js');
    const paritySrc = read('src/mcpParityTools.js');
    for (const t of [
      'photocapture.getConfig',
      'photocapture.listSubmissions',
      'photocapture.updateConfig',
      'photocapture.moderateSubmission',
      'photocapture.addToGallery',
    ]) {
      assert.ok(catalog.includes(`name: '${t}'`), `mcpCatalog carries ${t}`);
      assert.ok(mcpSrc.includes(`name: '${t}'`), `mcp tool defs carry ${t}`);
      assert.ok(mcpSrc.includes(`name === '${t}'`), `mcp dispatch handles ${t}`);
      assert.ok(mcpSrc.includes(`'${t}',`), `moduleToolNames gates ${t}`);
      assert.ok(paritySrc.includes(`'${t}': parityEntry(`), `local MCP parity implements ${t}`);
      n += 5;
    }

    // Routes.
    const pubRoutes = read('server/routes/modulesPublic.js');
    assert.ok(pubRoutes.includes("'/:token/photocapture'"), 'public photocapture submit route exists');
    assert.ok(pubRoutes.includes('applyModuleAssetUpload'), 'public submit reuses the module-asset pipeline');
    assert.ok(pubRoutes.includes('notifyOwnerOfPhotoSubmission'), 'owner is notified of a submission');
    n += 3;
    const portalRoutes = read('server/routes/portal.js');
    for (const r of [
      '/modules/photocapture/config',
      '/modules/photocapture/submissions/:id',
      '/modules/photocapture/submissions/:id/gallery',
    ]) {
      assert.ok(portalRoutes.includes(`'${r}'`), `portal route ${r} exists`);
      n++;
    }
    assert.ok(read('server.js').includes('photoUpload'), 'server JSON limit makes base64 photos reachable');
    n++;

    // UI + census + legal wiring.
    const portalJs = read('public/js/portal.js');
    assert.ok(portalJs.includes('renderPhotoCaptureAdminPanel'), 'portal renders the photo capture panel');
    assert.ok(
      portalJs.includes("type: 'photocapture', label: 'Photo Capture'"),
      'portal module list carries photocapture'
    );
    n += 2;
    const portalHtml = read('public/portal.html');
    assert.ok(portalHtml.includes('modules-pane-photocapture'), 'portal.html has the photocapture pane');
    assert.ok(portalHtml.includes('data-for="photocapture"'), 'portal.html has the photocapture pane tab');
    n += 2;
    const embedJs = read('public/js/module-embed.js');
    assert.ok(embedJs.includes('renderPhotoCapture'), 'embed renders photocapture');
    assert.ok(embedJs.includes("setAttribute('capture', 'environment')"), 'embed offers the device camera');
    assert.ok(embedJs.includes("photoInput.type = 'file'"), 'embed always has the file-upload fallback');
    n += 3;
    assert.ok(read('public/js/moduleIcons.js').includes('photocapture:'), 'module icon exists');
    assert.ok(
      read('server/portalSiteChat.js').includes('Photo Capture:'),
      'design-chat census carries the photocapture line'
    );
    const legal = read('src/siteLegal.js');
    assert.ok(legal.includes("'photocapture'"), 'legal module clauses include photocapture');
    assert.ok(legal.includes("m.has('photocapture')"), 'legal text has a photocapture clause');
    n += 4;
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
  const share = require(path.join(root, 'server/moduleShare.js'));
  const contacts = require(path.join(root, 'server/portalContacts.js'));

  const a = await workspace.createUserWithWorkspace({
    email: 'a125@example.invalid',
    password: ['batch125', 'ws', 'password'].join('-'),
    name: 'A125',
    workspaceName: 'Batch125 WS',
  });
  await platformDb.query('UPDATE users SET is_super_admin = 1 WHERE email = :e', { e: 'a125@example.invalid' });
  WS_ID = Number(a.workspaceId);
  db = openWorkspaceDb(WS_ID);
  sm.ensureTables(db);
  for (const [id, name, email] of [
    [LEAD_A, 'B125 Alpha Cuts', 'alpha125@example.invalid'],
    [LEAD_B, 'B125 Beta Lawns', 'beta125@example.invalid'],
  ]) {
    db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      'customer'
    );
    db.prepare('INSERT INTO websites (lead_id, name, theme, pages, status) VALUES (?, ?, ?, ?, ?)').run(
      id,
      `${name} Site`,
      '{}',
      JSON.stringify([{ slug: 'home', title: 'Home', html: '<p>hi</p>' }]),
      'draft'
    );
  }
  const embA = sm.ensureEmbed(db, LEAD_A, 'photocapture', { workspaceId: WS_ID });
  db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embA.id);
  const embB = sm.ensureEmbed(db, LEAD_B, 'photocapture', { workspaceId: WS_ID });
  db.prepare('UPDATE site_module_embeds SET published = 1 WHERE id = ?').run(embB.id);
  const albumA = sm.createAlbum(db, LEAD_A, { title: 'Customer Work', status: 'published', images: [] });
  const albumB = sm.createAlbum(db, LEAD_B, { title: 'Beta Album', status: 'published', images: [] });

  {
    let n = 0;
    // Config defaults + roundtrip.
    const cfg = sm.getPhotoCaptureConfig(db, LEAD_A);
    assert.equal(cfg.heading, 'Share your photo', 'default heading');
    assert.equal(cfg.show_approved, false, 'public grid is OFF by default');
    assert.equal(cfg.grid_limit, 12, 'default grid limit');
    assert.equal(cfg.success_message, 'Thanks — your photo is in.', 'default state-blind thanks');
    n += 4;
    const upd = sm.updatePhotoCaptureConfig(db, LEAD_A, {
      heading: 'Show us your cut',
      show_approved: true,
      grid_limit: 6,
    });
    assert.equal(upd.heading, 'Show us your cut');
    assert.equal(upd.show_approved, true);
    assert.equal(upd.grid_limit, 6);
    n += 3;

    // Dormant-empty: a fresh lead serves the block copy and no photos.
    const dormant = sm.getPublicModuleByToken(db, embB.public_token);
    assert.equal(dormant.module_type, 'photocapture');
    assert.ok(dormant.photocapture, 'payload carries the photocapture block');
    assert.equal(dormant.photocapture.config.heading, 'Share your photo');
    assert.deepEqual(dormant.items, [], 'no photos with zero submissions');
    n += 4;

    // Submission validation.
    assert.throws(
      () => sm.createPhotoSubmission(db, LEAD_A, { name: 'Pat', email: 'pat@example.invalid' }),
      (e) => e.code === 'VALIDATION',
      'a photo is required'
    );
    assert.throws(
      () =>
        sm.createPhotoSubmission(db, LEAD_A, { email: 'pat@example.invalid', image_url: 'https://img.example/x.jpg' }),
      (e) => e.code === 'VALIDATION',
      'a name is required'
    );
    assert.throws(
      () => sm.createPhotoSubmission(db, LEAD_A, { name: 'Pat', image_url: 'https://img.example/x.jpg' }),
      (e) => e.code === 'VALIDATION',
      'email or phone is required'
    );
    n += 3;

    // A submission lands pending, and LeadScout captures it.
    const sub1 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Pat Cutter',
      email: 'pat@example.invalid',
      message: 'Fresh fade, thanks!',
      image_url: 'https://img.example/pat.jpg',
      image_src: 'images/module-pat.jpg',
      page_slug: 'home',
    });
    assert.equal(sub1.status, 'pending', 'submissions start pending');
    n++;
    const contactRow = db.prepare('SELECT * FROM leadscout_contacts WHERE email_norm = ?').get('pat@example.invalid');
    assert.ok(contactRow, 'LeadScout contact created from the submission');
    const ev = db
      .prepare("SELECT * FROM leadscout_events WHERE photo_submission_id = ? AND kind = 'photo'")
      .get(sub1.id);
    assert.ok(ev, "LeadScout 'photo' event recorded for the submission");
    assert.equal(Number(ev.contact_id), Number(contactRow.id), 'event hangs off the deduped contact');
    n += 3;
    const health = contacts.captureHealth(db, { leadId: LEAD_A });
    assert.equal(health.ok, true, 'capture-health clean after a photo capture');
    assert.equal(health.open_failures, 0);
    n += 2;
    // Second submission, same person → same contact, second event.
    const sub2 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Pat Cutter',
      email: 'pat@example.invalid',
      message: 'Second visit',
      image_url: 'https://img.example/pat2.jpg',
      image_src: 'images/module-pat2.jpg',
    });
    const contactCount = db
      .prepare('SELECT COUNT(*) AS c FROM leadscout_contacts WHERE email_norm = ?')
      .get('pat@example.invalid');
    assert.equal(contactCount.c, 1, 'repeat submitter dedupes to one contact');
    const evCount = db.prepare("SELECT COUNT(*) AS c FROM leadscout_events WHERE kind = 'photo'").get();
    assert.equal(evCount.c, 2, 'one photo event per submission');
    n += 2;
    assert.equal(sm.countPhotoSubmissions(db, LEAD_A).pending, 2, 'two pending');
    assert.equal(sm.moduleItemCount(db, LEAD_A, 'photocapture'), 2, 'tab badge counts the moderation queue');
    n += 2;

    // Pending is invisible on every public surface.
    assert.deepEqual(
      share.listSharedItems(db, LEAD_A, 'photocapture'),
      [],
      'pending photos stay out of the shared layer'
    );
    const srcRow = share.listSharedSources(db, LEAD_A, { sample: 0 }).find((s) => s.type === 'photocapture');
    assert.equal(srcRow.count, 0, 'shared source count is 0 while pending');
    const payloadPending = sm.getPublicModuleByToken(db, embA.public_token);
    assert.deepEqual(payloadPending.items, [], 'pending photos stay out of the public grid');
    n += 3;

    // Approve → visible via shared layer + grid. Reject → invisible.
    // Re-approve a rejected photo → visible again (one-way-safe).
    sm.updatePhotoSubmissionStatus(db, LEAD_A, sub1.id, 'approved');
    let items = share.listSharedItems(db, LEAD_A, 'photocapture');
    assert.equal(items.length, 1, 'approved photo enters the shared layer');
    assert.equal(items[0].source_type, 'photocapture');
    assert.equal(items[0].image_url, 'https://img.example/pat.jpg', 'shared item carries the photo as image_url');
    assert.equal(items[0].title, 'Pat Cutter');
    assert.equal(Number(items[0].meta.submission_id), sub1.id);
    n += 5;
    const payloadApproved = sm.getPublicModuleByToken(db, embA.public_token);
    assert.equal(payloadApproved.items.length, 1, 'approved photo shows in the public grid');
    assert.equal(payloadApproved.items[0].image_url, 'https://img.example/pat.jpg');
    n += 2;
    sm.updatePhotoSubmissionStatus(db, LEAD_A, sub1.id, 'rejected');
    assert.deepEqual(share.listSharedItems(db, LEAD_A, 'photocapture'), [], 'rejected photo leaves the shared layer');
    assert.deepEqual(sm.getPublicModuleByToken(db, embA.public_token).items, [], 'rejected photo leaves the grid');
    n += 2;
    const reApproved = sm.updatePhotoSubmissionStatus(db, LEAD_A, sub1.id, 'approved');
    assert.equal(reApproved.status, 'approved', 're-approving a rejected photo is allowed');
    assert.equal(share.listSharedItems(db, LEAD_A, 'photocapture').length, 1);
    n += 2;
    assert.throws(
      () => sm.updatePhotoSubmissionStatus(db, LEAD_A, sub1.id, 'bogus'),
      (e) => e.code === 'VALIDATION',
      'unknown status refused'
    );
    n++;

    // Add to gallery: pending refused; approved writes a real row via
    // the gallery's own function; idempotent; cross-lead refused.
    assert.throws(
      () => sm.addPhotoSubmissionToGallery(db, LEAD_A, sub2.id, albumA.id),
      (e) => e.code === 'VALIDATION',
      'a pending photo cannot enter the gallery'
    );
    n++;
    const pushed = sm.addPhotoSubmissionToGallery(db, LEAD_A, sub1.id, albumA.id);
    assert.equal(pushed.already, false);
    const gRow = db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(pushed.image.id);
    assert.ok(gRow, 'a real gallery_images row exists');
    assert.equal(Number(gRow.album_id), albumA.id, 'the row is in the chosen album');
    assert.equal(gRow.image_url, 'https://img.example/pat.jpg', 'the row carries the photo');
    assert.equal(
      Number(sm.getPhotoSubmission(db, LEAD_A, sub1.id).gallery_image_id),
      Number(gRow.id),
      'submission records the push'
    );
    n += 5;
    const again = sm.addPhotoSubmissionToGallery(db, LEAD_A, sub1.id, albumA.id);
    assert.equal(again.already, true, 'a second push is a no-op');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM gallery_images WHERE album_id = ?').get(albumA.id).c,
      1,
      'still exactly one gallery row'
    );
    n += 2;
    assert.throws(
      () => sm.addPhotoSubmissionToGallery(db, LEAD_B, sub1.id, albumB.id),
      (e) => e.code === 'NOT_FOUND',
      "another lead's submission id never resolves"
    );
    assert.throws(
      () => sm.addPhotoSubmissionToGallery(db, LEAD_A, sub1.id, albumB.id),
      (e) => e.code === 'NOT_FOUND',
      "another lead's album id never resolves"
    );
    n += 2;

    // Strict lead isolation on reads + moderation.
    assert.equal(sm.getPhotoSubmission(db, LEAD_B, sub1.id), null, 'cross-lead get returns nothing');
    assert.throws(
      () => sm.updatePhotoSubmissionStatus(db, LEAD_B, sub1.id, 'rejected'),
      (e) => e.code === 'NOT_FOUND',
      'cross-lead moderation refused'
    );
    assert.deepEqual(sm.listPhotoSubmissions(db, LEAD_B), [], 'lead B inbox is empty');
    assert.equal(share.listSharedItems(db, LEAD_B, 'photocapture').length, 0, 'lead B shared items empty');
    n += 4;

    // Per-record delete unlinks the LeadScout event.
    sm.deletePhotoSubmission(db, LEAD_A, sub2.id);
    assert.equal(sm.getPhotoSubmission(db, LEAD_A, sub2.id), null, 'deleted submission is gone');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM leadscout_events WHERE photo_submission_id = ?').get(sub2.id).c,
      0,
      'its LeadScout event is unlinked'
    );
    n += 2;

    // Module purge counts cover the new tables.
    const counts = sm.moduleContentCounts(db, LEAD_A, 'photocapture');
    assert.ok(
      counts.parts.some((p) => p.table === 'photocapture_submissions' && p.count === 1),
      'purge counts submissions'
    );
    assert.ok(
      counts.parts.some((p) => p.table === 'photocapture_configs'),
      'purge counts the config'
    );
    n += 2;
    group('Part 2 engine: config, capture, moderation, gallery push, isolation', n);
  }

  {
    let n = 0;
    // Agent tool surface through the real MCP dispatch.
    const mcp = require(path.join(root, 'server/mcp.js'));
    const cfgRes = await mcp.callTool(WS_ID, 'photocapture.getConfig', { leadId: LEAD_A }, {});
    assert.equal(cfgRes.ok, true, 'photocapture.getConfig dispatches');
    assert.equal(cfgRes.data.config.heading, 'Show us your cut');
    assert.equal(cfgRes.data.counts.approved, 1);
    n += 3;
    const list = await mcp.callTool(WS_ID, 'photocapture.listSubmissions', { leadId: LEAD_A, status: 'approved' }, {});
    assert.equal(list.ok, true);
    assert.equal(list.data.submissions.length, 1, 'agent lists the approved submission');
    n += 2;
    const sub3 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Jo Agent',
      phone: '+1 555 010 2030',
      image_url: 'https://img.example/jo.jpg',
      image_src: 'images/module-jo.jpg',
    });
    const mod = await mcp.callTool(
      WS_ID,
      'photocapture.moderateSubmission',
      { leadId: LEAD_A, id: sub3.id, status: 'approved' },
      {}
    );
    assert.equal(mod.ok, true, 'photocapture.moderateSubmission dispatches');
    assert.equal(mod.data.submission.status, 'approved', 'agent approval lands through the same engine function');
    n += 2;
    const gal = await mcp.callTool(
      WS_ID,
      'photocapture.addToGallery',
      { leadId: LEAD_A, id: sub3.id, album_id: albumA.id },
      {}
    );
    assert.equal(gal.ok, true, 'photocapture.addToGallery dispatches');
    assert.ok(gal.data.image && gal.data.image.id, 'agent gallery push returns the gallery image');
    n += 2;
    const cross = await mcp.callTool(
      WS_ID,
      'photocapture.moderateSubmission',
      { leadId: LEAD_B, id: sub3.id, status: 'rejected' },
      {}
    );
    assert.equal(cross.ok, false, 'cross-lead moderation through the agent surface fails');
    n++;
    group('Part 2b agent tools via MCP dispatch', n);
  }

  {
    let n = 0;
    // Batch 125 finisher — the Categories wire (Batch 124's service,
    // scope 'photocapture'): submissions are assignable in EVERY
    // moderation state, carry category_ids on the module's own reads,
    // take category_ids on the moderation write (pre-flighted), and
    // resolve through itemsForCategory only once approved.
    const cats = require(path.join(root, 'server/categories.js'));
    const mcp = require(path.join(root, 'server/mcp.js'));
    const catA = cats.createCategory(db, LEAD_A, {
      scope: 'photocapture',
      name: 'Before & After',
      status: 'published',
    });
    const catEvents = cats.createCategory(db, LEAD_A, { scope: 'events', name: 'Not Photos', status: 'published' });
    const sub4 = sm.createPhotoSubmission(db, LEAD_A, {
      name: 'Sam Taxonomy',
      email: 'sam@example.com',
      image_url: 'https://img.example/sam.jpg',
      image_src: 'images/module-sam.jpg',
    });
    assert.equal(sub4.status, 'pending');
    n++;

    // Assign while PENDING — the ITEM_READERS entry makes pending
    // submissions valid targets (provider fallback would refuse them).
    const asg = cats.assignItem(db, LEAD_A, {
      consumer_type: 'photocapture',
      item_id: sub4.id,
      category_id: catA.id,
    });
    assert.equal(asg.assigned, true, 'pending photo submission is assignable');
    const listed = sm.listPhotoSubmissions(db, LEAD_A, {}).find((s) => s.id === sub4.id);
    assert.deepEqual(listed.category_ids, [catA.id], 'list rows carry category_ids');
    assert.deepEqual(sm.getPhotoSubmission(db, LEAD_A, sub4.id).category_ids, [catA.id], 'get carries category_ids');
    n += 3;

    // Cross-scope + phantom assignments refused.
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumer_type: 'photocapture', item_id: sub4.id, category_id: catEvents.id }),
      (e) => e.code === 'VALIDATION',
      'an events-scope category cannot organize a photo'
    );
    assert.throws(
      () => cats.assignItem(db, LEAD_A, { consumer_type: 'photocapture', item_id: 999999, category_id: catA.id }),
      (e) => e.code === 'VALIDATION',
      'phantom submission refused'
    );
    assert.throws(
      () => cats.assignItem(db, LEAD_B, { consumer_type: 'photocapture', item_id: sub4.id, category_id: catA.id }),
      (e) => e.code === 'VALIDATION',
      'cross-lead assignment refused'
    );
    n += 3;

    // A bad category id on the moderation write fails BEFORE the
    // status mutation (pre-flight), leaving the submission untouched.
    assert.throws(
      () => sm.updatePhotoSubmissionStatus(db, LEAD_A, sub4.id, 'approved', { category_ids: [987654] }),
      (e) => e.code === 'VALIDATION',
      'bogus category id refused on the moderation write'
    );
    assert.equal(sm.getPhotoSubmission(db, LEAD_A, sub4.id).status, 'pending', 'failed write changed nothing');
    n += 2;

    // Categories-only save (null status — the portal inbox picker):
    // replaces the set, leaves the status alone.
    const cleared = sm.updatePhotoSubmissionStatus(db, LEAD_A, sub4.id, null, { category_ids: [] });
    assert.equal(cleared.status, 'pending', 'categories-only save does not touch status');
    assert.deepEqual(cleared.category_ids, [], 'categories-only save replaces the set');
    n += 2;

    // Approve WITH categories in one call → the category view
    // resolves the photo; reject → it leaves the category view
    // (published-only resolution), assignments themselves survive.
    const approved = sm.updatePhotoSubmissionStatus(db, LEAD_A, sub4.id, 'approved', { category_ids: [catA.id] });
    assert.equal(approved.status, 'approved');
    assert.deepEqual(approved.category_ids, [catA.id]);
    let catItems = cats.itemsForCategory(db, LEAD_A, catA);
    assert.equal(catItems.length, 1, 'approved + categorized photo resolves through its category');
    assert.equal(catItems[0].source_type, 'photocapture');
    assert.equal(Number(catItems[0].source_id), sub4.id);
    n += 4;
    sm.updatePhotoSubmissionStatus(db, LEAD_A, sub4.id, 'rejected');
    catItems = cats.itemsForCategory(db, LEAD_A, catA);
    assert.equal(catItems.length, 0, 'rejected photo leaves the category view');
    assert.deepEqual(
      cats.listItemCategoryIds(db, LEAD_A, 'photocapture', sub4.id),
      [catA.id],
      'the assignment itself survives moderation'
    );
    n += 2;

    // The agent surface drives the same wire: categories.assign via
    // MCP dispatch + category_ids on photocapture.moderateSubmission.
    sm.updatePhotoSubmissionStatus(db, LEAD_A, sub4.id, 'approved', { category_ids: [] });
    const agAsg = await mcp.callTool(
      WS_ID,
      'categories.assign',
      { leadId: LEAD_A, category_id: catA.id, consumer_type: 'photocapture', item_id: sub4.id },
      {}
    );
    assert.equal(agAsg.ok, true, 'categories.assign dispatches for a photocapture item');
    const agMod = await mcp.callTool(
      WS_ID,
      'photocapture.moderateSubmission',
      { leadId: LEAD_A, id: sub4.id, status: 'approved', category_ids: [] },
      {}
    );
    assert.equal(agMod.ok, true, 'moderateSubmission with category_ids dispatches');
    assert.deepEqual(agMod.data.submission.category_ids, [], 'agent write replaced the set');
    n += 3;

    // Deleting the category removes assignments, never the photo;
    // deleting the photo clears its assignments.
    cats.assignItem(db, LEAD_A, { consumer_type: 'photocapture', item_id: sub4.id, category_id: catA.id });
    cats.deleteCategory(db, LEAD_A, catA.id);
    assert.deepEqual(
      cats.listItemCategoryIds(db, LEAD_A, 'photocapture', sub4.id),
      [],
      'category delete sweeps assignments'
    );
    assert.ok(sm.getPhotoSubmission(db, LEAD_A, sub4.id), 'the photo itself survives its category');
    const catB = cats.createCategory(db, LEAD_A, { scope: 'photocapture', name: 'Second', status: 'published' });
    cats.assignItem(db, LEAD_A, { consumer_type: 'photocapture', item_id: sub4.id, category_id: catB.id });
    sm.deletePhotoSubmission(db, LEAD_A, sub4.id);
    assert.deepEqual(
      cats.listItemCategoryIds(db, LEAD_A, 'photocapture', sub4.id),
      [],
      'photo delete clears its assignments'
    );
    n += 3;
    group('Part 2c categories wire (finisher)', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
    let n = 0;
    const q = platformDb.query;
    const bcrypt = require('bcryptjs');
    await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 1, :s)', {
      e: 'owner125@example.invalid',
      h: bcrypt.hashSync('UnusedPass125!', 12),
      n: 'B125 Portal Link',
      s: 'active',
    });
    await q(
      `INSERT INTO client_portal_users (email, password_hash, workspace_id, lead_id, business_name, status, user_type)
       VALUES (:e, :h, :w, :l, :b, 'active', 'owner')`,
      { e: 'owner125@example.invalid', h: bcrypt.hashSync(PW, 12), w: WS_ID, l: LEAD_A, b: 'B125 Alpha Cuts' }
    );

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

      const pub = `${BASE}/api/v1/modules/public/${embA.public_token}`;
      // Public payload before any HTTP submission: grid on, the two
      // engine-approved photos show; nothing else leaks.
      {
        const res = await fetch(pub);
        assert.equal(res.status, 200, 'public payload serves');
        const data = await json(res);
        const payload = data.data || data;
        assert.equal(payload.module_type, 'photocapture');
        assert.equal(payload.photocapture.config.heading, 'Show us your cut');
        assert.equal(payload.items.length, 2, 'the two approved photos are in the grid');
        assert.ok(
          !JSON.stringify(payload).includes('pat@example.invalid'),
          'submitter contact details never ship publicly'
        );
        n += 5;
      }
      // A phone-camera-style submission: base64 data URL in JSON.
      let httpSubId = null;
      {
        const res = await fetch(`${pub}/photocapture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Sam Site',
            email: 'sam@example.invalid',
            message: 'Sent from my phone',
            image: PNG_1PX,
          }),
        });
        assert.equal(res.status, 200, 'photo submission accepted');
        const data = await json(res);
        assert.equal(data.ok, true);
        assert.equal(data.data.message, 'Thanks — your photo is in.', 'state-blind thanks, exactly as configured');
        assert.ok(!('status' in data.data) && !('submission' in data.data), 'response carries no moderation state');
        n += 4;
        const row = db
          .prepare("SELECT * FROM photocapture_submissions WHERE lead_id = ? AND email = 'sam@example.invalid'")
          .get(LEAD_A);
        assert.ok(row, 'the submission landed in the inbox');
        assert.equal(row.status, 'pending', 'the HTTP submission starts pending');
        assert.ok(String(row.image_src).startsWith('images/module-'), 'photo stored by the module-asset pipeline');
        httpSubId = row.id;
        n += 3;
        const contact = db.prepare('SELECT id FROM leadscout_contacts WHERE email_norm = ?').get('sam@example.invalid');
        assert.ok(contact, 'HTTP submission captured into LeadScout');
        n++;
      }
      // Non-image refused; oversize refused; missing fields refused;
      // bogus token 404.
      {
        const notImage = await fetch(`${pub}/photocapture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Sam Site',
            email: 'sam@example.invalid',
            image: 'data:text/plain;base64,' + Buffer.from('just some text, not an image').toString('base64'),
          }),
        });
        assert.equal(notImage.status, 400, 'a non-image is refused');
        n++;
        // Over the pipeline's 5.5 MB decoded cap, under the 8 MB JSON
        // tier — so the refusal provably comes from the pipeline.
        const big = Buffer.alloc(Math.floor(5.75 * 1024 * 1024), 7);
        const oversize = await fetch(`${pub}/photocapture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Sam Site',
            email: 'sam@example.invalid',
            image: 'data:image/png;base64,' + big.toString('base64'),
          }),
        });
        assert.equal(oversize.status, 400, 'an oversize photo is refused by the pipeline cap');
        n++;
        const noContact = await fetch(`${pub}/photocapture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Sam Site', image: PNG_1PX }),
        });
        assert.equal(noContact.status, 400, 'email-or-phone is required');
        n++;
        const bogus = await fetch(`${BASE}/api/v1/modules/public/${WS_ID}_bogus/photocapture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Sam Site', email: 'sam@example.invalid', image: PNG_1PX }),
        });
        assert.equal(bogus.status, 404, 'a bogus token 404s');
        n++;
        const rows = db
          .prepare(
            "SELECT COUNT(*) AS c FROM photocapture_submissions WHERE lead_id = ? AND email = 'sam@example.invalid'"
          )
          .get(LEAD_A);
        assert.equal(rows.c, 1, 'refused submissions left no rows');
        n++;
      }
      // Portal: anonymous refused, owner moderates + pushes to gallery.
      const post = (jar, p, body) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(body || {}) });
      {
        const anon = await fetch(`${BASE}/api/v1/portal/modules/photocapture`);
        assert.equal(anon.status, 401, 'anonymous portal photocapture refused');
        n++;
      }
      const owner = makeJar();
      {
        const res = await post(owner, '/api/v1/portal/login', { email: 'owner125@example.invalid', password: PW });
        assert.equal(res.status, 200, 'portal owner login');
        n++;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/photocapture`);
        assert.equal(res.status, 200, 'portal photocapture list');
        const data = await json(res);
        const block = (data.data || data).photocapture;
        assert.ok(block, 'portal payload carries the photocapture block');
        const mine = block.submissions.find((s) => Number(s.id) === Number(httpSubId));
        assert.ok(mine && mine.status === 'pending', 'the HTTP submission is in the portal inbox, pending');
        assert.ok(
          block.albums.some((al) => Number(al.id) === albumA.id),
          'the inbox carries albums for Add to gallery'
        );
        n += 4;
      }
      {
        const res = await owner.fetch(`${BASE}/api/v1/portal/modules/photocapture/submissions/${httpSubId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'approved' }),
        });
        assert.equal(res.status, 200, 'portal approve');
        const data = await json(res);
        assert.equal((data.data || data).submission.status, 'approved');
        n += 2;
        const pubRes = await fetch(pub);
        const payload = (await json(pubRes)).data || {};
        assert.ok(
          payload.items.some((i) => String(i.image_url || '').includes('module-')),
          'the approved HTTP photo now serves in the public grid'
        );
        n++;
      }
      {
        const res = await post(owner, `/api/v1/portal/modules/photocapture/submissions/${httpSubId}/gallery`, {
          album_id: albumA.id,
        });
        assert.equal(res.status, 200, 'portal add-to-gallery');
        const data = await json(res);
        const payload = data.data || data;
        assert.ok(payload.image && payload.image.id, 'gallery push returns the gallery image');
        const gRow = db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(payload.image.id);
        assert.equal(Number(gRow.album_id), albumA.id, 'the HTTP-pushed row is in the right album');
        n += 3;
      }
      {
        const put = (jar, p, body) => jar.fetch(BASE + p, { method: 'PUT', body: JSON.stringify(body || {}) });
        const res = await put(owner, '/api/v1/portal/modules/photocapture/config', { heading: 'HTTP Heading' });
        assert.equal(res.status, 200, 'portal config save');
        const pubRes = await fetch(pub);
        const payload = (await json(pubRes)).data || {};
        assert.equal(payload.photocapture.config.heading, 'HTTP Heading', 'the public payload serves the saved config');
        n += 2;
      }
      group('Part 3 HTTP submit + moderate + gallery push', n);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }

  console.log(`\nBATCH125 ALL PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH125 FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
