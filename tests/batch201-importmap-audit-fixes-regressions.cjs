'use strict';
/**
 * Batch 201 — IMPORTMAP + EXPORT-AUDIT BOOT FIXES (Ely approved
 * 2026-11-20: "Fix both defects as Batch 201"). Both defects were
 * surfaced by the Victoria full-redesign test of Batches 197–200
 * (2026-11-20) and proven in the container's Chrome 155 before this
 * batch was written.
 *
 * DEFECT 1 — Batch 199's importmap is not a valid importmap.
 * libHeadTags emitted the bare specifier map
 * ({"three":"…","three/addons/":"…"}) with no top-level "imports"
 * wrapper. The HTML spec requires {"imports": {…}}; browsers reject
 * the bare shape, so EVERY module section script importing 'three'
 * failed with "Failed to resolve module specifier" — the whole
 * three.js path of Part D1 was dead in visitors' browsers while the
 * Batch 199 suite (which only string-matched the addons URL inside
 * the JSON) stayed green. Fix: emit JSON.stringify({ imports: map })
 * at the single emitter in src/sectionScripts.js.
 *
 * DEFECT 2 — the export audit audited files after the first with
 * their embeds unbooted. assessExportedFiles loaded every file into
 * ONE shared page via setContent swaps. The embed loaders
 * (form-embed.js / module-embed.js) stamp a __booted guard on window
 * at first execution and return early on any later execution in the
 * same realm — and the realm survives a setContent swap — so on
 * every swapped-in document the loaders never booted: form mounts
 * stayed empty placeholders and Victoria's contact.html drew exactly
 * 4 FALSE template-hook violations (form + name/email/message — the
 * form the embed would have built), while module content measured
 * unstyled. Fix: a FRESH PAGE PER FILE in assessExportedFilesInner,
 * so each file gets a real first load. Batch 200's discipline is
 * preserved verbatim: fail-closed accounting (filesSelected /
 * filesFailed / fewer-measured-than-selected fails the export), the
 * wedged-page rule (one discard tolerated audit-wide via stallSeen,
 * a second stall aborts with SPACING_AUDIT_ENV), the post-embed
 * settle wait, load-once-per-file with resize measurement, and the
 * 360s export budget.
 *
 *   Part 1 — source pins for both fixes + preserved discipline.
 *   Part 2 — importmap shape: libHeadTags unit checks + an engine
 *     end-to-end render; the emitted JSON must parse to exactly
 *     { imports: { three, "three/addons/" } } (FAILS on the pre-fix
 *     tree — the negative control).
 *   Part 3 — export browser audit: a multi-file fixture whose embed
 *     file is NOT first audits with the embed booted (form fields in
 *     the audit DOM, zero template-hook violations); an unreadable
 *     file is recorded in filesFailed, never silently skipped.
 *     Skips without a browser (prints B201-BROWSER-PART: SKIPPED;
 *     prints B201-BROWSER-PART: RAN when it executes).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b201-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch201', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 33).toString('base64');

const THEME = {
  primary: '#1d4633',
  secondary: '#0e2c1f',
  bg: '#fffaf4',
  text: '#241d18',
  font: 'Karla',
  headingFont: 'Fraunces',
};

let groups = 0;
function group(name, n) {
  groups += 1;
  console.log(`  ✓ ${name} (${n} checks)`);
}

(async () => {
  const scriptLibs = require(path.join(root, 'src/scriptLibs.js'));
  const sectionScripts = require(path.join(root, 'src/sectionScripts.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));
  const spacingQa = require(path.join(root, 'server/spacingQa.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const ss = read('src/sectionScripts.js');
    assert.ok(
      ss.includes('JSON.stringify({ imports: importMap })'),
      'the importmap is emitted with the spec-required imports wrapper'
    );
    n++;
    assert.ok(!ss.includes('JSON.stringify(importMap)'), 'the bare (invalid) importmap emission is gone');
    n++;
    const sq = read('server/spacingQa.js');
    assert.ok(sq.includes('FRESH PAGE PER FILE'), 'the export audit documents the fresh-page rule');
    n++;
    assert.ok(sq.includes('stallSeen'), 'the audit-wide wedged-page flag is carried as stallSeen');
    n++;
    assert.ok((sq.match(/SPACING_AUDIT_ENV/g) || []).length >= 2, 'the SPACING_AUDIT_ENV environment abort is intact');
    n++;
    assert.ok(sq.includes('360000'), 'the 360s export audit budget is intact');
    n++;
    assert.ok(sq.includes('waitForEmbedSettle'), 'the post-embed settle wait is intact');
    n++;
    assert.ok(sq.includes('filesFailed'), 'per-file failure accounting is intact');
    n++;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — importmap shape (unit + engine end-to-end)                 */
  /* ================================================================== */
  {
    let n = 0;
    const three = scriptLibs.getLib('three');
    const gsap = scriptLibs.getLib('gsap');
    const extractMap = (html) => {
      const m = String(html).match(/<script type="importmap" data-bp-importmap="1">([\s\S]*?)<\/script>/);
      assert.ok(m, 'an importmap tag is emitted');
      return JSON.parse(m[1]);
    };
    const assertSpecShape = (parsed, label) => {
      assert.deepEqual(Object.keys(parsed), ['imports'], `${label}: the importmap's only top-level key is "imports"`);
      assert.equal(parsed.imports.three, three.importMap.three, `${label}: imports.three is the pinned module URL`);
      assert.equal(
        parsed.imports['three/addons/'],
        three.importMap['three/addons/'],
        `${label}: imports["three/addons/"] is the pinned addons prefix`
      );
      assert.ok(!('three' in parsed), `${label}: no bare top-level "three" specifier (the Batch 199 defect)`);
    };

    // Unit: three alone.
    const headThree = sectionScripts.libHeadTags(['three']);
    assert.equal(headThree.split('<script type="importmap"').length - 1, 1, 'exactly one importmap for three');
    n++;
    assertSpecShape(extractMap(headThree), 'libHeadTags(three)');
    n += 4;

    // Unit: classic-only page emits NO importmap.
    const headGsap = sectionScripts.libHeadTags(['gsap']);
    assert.ok(!headGsap.includes('importmap'), 'a classic-only page emits no importmap');
    n++;
    assert.ok(
      headGsap.includes(`<script src="${gsap.url}" integrity="${gsap.integrity}"`) &&
        headGsap.includes('data-bp-lib="gsap"'),
      'the classic gsap tag is unchanged (SRI + lib stamp)'
    );
    n++;

    // Unit: three + gsap — one wrapped importmap AND the classic tag.
    const headBoth = sectionScripts.libHeadTags(['three', 'gsap']);
    assert.equal(
      headBoth.split('<script type="importmap"').length - 1,
      1,
      'one importmap when three+gsap are declared'
    );
    n++;
    assertSpecShape(extractMap(headBoth), 'libHeadTags(three,gsap)');
    n += 4;
    assert.ok(headBoth.includes('data-bp-lib="gsap"'), 'gsap classic tag still emitted alongside the importmap');
    n++;

    // Unit: no libs → no head tags at all.
    assert.equal(sectionScripts.libHeadTags([]), '', 'no libs, no head tags');
    n++;

    // Engine end-to-end: two module sections sharing three render a
    // page whose single importmap parses to the spec shape.
    const nav = { type: 'nav', content: { business_name: 'B201 Biz', links: [{ label: 'Home', href: '#home' }] } };
    const foot = { type: 'footer', content: {} };
    const modulePage = {
      slug: 'index',
      title: 'Home',
      sections: [
        nav,
        {
          type: 'hero',
          content: { headline: 'A' },
          js: 'import * as THREE from "three";\nwindow.__a = 1;',
          libs: ['three'],
          jsModule: true,
        },
        {
          type: 'text',
          content: { title: 'T', body: 'B' },
          js: 'import { OrbitControls } from "three/addons/controls/OrbitControls.js";\nwindow.__b = 1;',
          libs: ['three'],
          jsModule: true,
        },
        foot,
      ],
    };
    const moduleHtml = engine.renderPage(modulePage, [modulePage], THEME, {});
    assert.equal(
      moduleHtml.split('<script type="importmap"').length - 1,
      1,
      'rendered page carries exactly one importmap'
    );
    n++;
    assertSpecShape(extractMap(moduleHtml), 'renderPage(three)');
    n += 4;
    group('Part 2 — importmap shape', n);
  }

  /* ================================================================== */
  /* Part 3 — export audit: embeds boot on non-first files               */
  /* ================================================================== */
  {
    let n = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b201-audit-'));
    const page = (inner) =>
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>' +
      '<style>body{margin:0}section.band{padding-left:28px;padding-right:28px}</style></head><body>' +
      inner +
      '</body></html>';
    // The fixture loader mirrors form-embed.js's boot contract
    // EXACTLY: the __booted guard is checked first and the global is
    // stamped __booted:true at script execution (before boot runs);
    // boot waits for DOMContentLoaded while readyState is 'loading'.
    // It builds the same <form> (name/email/message fields) the real
    // embed builds. Like a real export, the loader tag rides on
    // every page. Under the pre-fix shared-page audit, the first
    // file's execution stamps the guard in the surviving realm, the
    // contact file's loader returns early, and contact.html draws
    // the 4 false template-hook violations Victoria drew.
    const loader =
      '<script>(function(){' +
      'if(window.__fixtureForms&&window.__fixtureForms.__booted)return;' +
      'function boot(){' +
      'var m=document.querySelector("[data-bitpype-form-embed]");if(!m)return;' +
      'm.innerHTML="<form method=\\"post\\" action=\\"#\\">" +' +
      '"<label>Name <input type=\\"text\\" name=\\"name\\"></label>" +' +
      '"<label>Email <input type=\\"email\\" name=\\"email\\"></label>" +' +
      '"<label>Message <textarea name=\\"message\\"></textarea></label>" +' +
      '"<button type=\\"submit\\">Send</button></form>";}' +
      'window.__fixtureForms={__booted:true,boot:boot};' +
      'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}else{boot();}' +
      '})();</script>';
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      page('<section class="band"><p style="margin:0">Clean home page.</p></section>' + loader)
    );
    // The embed file, deliberately NOT first (index.html sorts first).
    fs.writeFileSync(
      path.join(dir, 'contact.html'),
      page(
        '<section class="band" data-ws-section-type="contact_form" data-template="custom" id="contact">' +
          '<h2 style="margin:0 0 12px">Contact us</h2>' +
          '<div data-bitpype-form-embed="fixture-token"><p class="bp-mod-loading">Loading…</p></div>' +
          '</section>' +
          loader
      )
    );
    fs.writeFileSync(
      path.join(dir, 'zzz.html'),
      page('<section class="band"><p style="margin:0">Clean last page.</p></section>' + loader)
    );

    let audit = null;
    let auditErr = null;
    try {
      audit = await spacingQa.assessExportedFiles(
        { dir, files: ['index.html', 'contact.html', 'zzz.html'] },
        { widths: [390] }
      );
    } catch (e) {
      auditErr = e;
    }
    if (audit) {
      console.log('  B201-BROWSER-PART: RAN');
      assert.equal(audit.filesAudited, 3, 'all three fixture files were measured');
      n++;
      assert.equal((audit.filesFailed || []).length, 0, 'no fixture file failed to measure');
      n++;
      assert.ok(
        audit.embeds && audit.embeds.mounts >= 1 && audit.embeds.rendered >= 1,
        'the audit saw the non-first file’s embed mount render (booted, not a placeholder)'
      );
      n++;
      const hooks = (audit.violations || []).filter((v) => v.kind === 'template-hook');
      assert.equal(
        hooks.length,
        0,
        `no false template-hook violations from unbooted embeds (got ${JSON.stringify(hooks).slice(0, 300)})`
      );
      n++;
      assert.ok(
        !(audit.violations || []).some((v) => v.page === 'contact.html' && v.kind === 'template-hook'),
        'contact.html (not first) draws no template-hook violations — its embed booted'
      );
      n++;

      // Fail-closed accounting intact: an unreadable file is a
      // recorded per-file failure, never a silent skip.
      const audit2 = await spacingQa.assessExportedFiles(
        { dir, files: ['index.html', 'ghost.html'] },
        { widths: [390] }
      );
      assert.equal(audit2.filesAudited, 1, 'the readable file is still measured');
      n++;
      assert.equal((audit2.filesFailed || []).length, 1, 'the unreadable file is recorded as failed');
      n++;
      assert.ok(String((audit2.filesFailed || [])[0].file) === 'ghost.html', 'the failed file is named in filesFailed');
      n++;
    } else {
      console.log(`  B201-BROWSER-PART: SKIPPED (${auditErr && (auditErr.code || auditErr.message)})`);
    }
    group('Part 3 — export audit boots embeds on every file', n);
  }

  console.log(`\nbatch201: all ${groups} groups passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
