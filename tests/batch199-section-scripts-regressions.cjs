'use strict';
/**
 * Batch 199 — MODULE CUSTOMIZATION, PART D1: custom JavaScript for
 * designs (section script slot + pinned library registry + script
 * QA). Ely ordered 2026-11-19 ("continue with D1") after approving
 * the Part D spec (module-customization-part-d-js-spec.md).
 *
 * What D1 ships:
 *   - src/scriptLibs.js — the platform-pinned library registry
 *     (three 0.160.0 module + importmap, gsap 3.12.5 classic, SRI
 *     hashes, perf budgets). Agent-chosen URLs are not a channel.
 *   - src/sectionScripts.js — the section script slot: section.js /
 *     libs / jsModule / jsExpect, stored ONLY when set (Batch
 *     148/188/197 discipline), save-time validation (caps, vm.Script
 *     syntax — parse only, the static denylist, registry membership
 *     + kind coherence, registry-only import specifiers), and the
 *     emission builders (root/el wrapper, per-instance try/catch,
 *     lib-missing skip, body-end tags, merged importmap).
 *   - Engine: visitor renders stamp data-bp-sec (+ data-bp-js-expect)
 *     on scripted roots and inject lib tags + wrapped scripts;
 *     the portal edit canvas / layout editor receive NEITHER (design
 *     scripts never execute on the platform origin). QA gains the
 *     static `section-scripts-valid` check.
 *   - spacingQa: the export script pass — fresh load, listeners,
 *     settle + scroll-through; fails on script errors, lib-missing,
 *     off-allowlist script hosts, missing jsExpect targets, template
 *     hooks eaten post-run, and over-budget script transfer.
 *   - Preview CSP gains 'wasm-unsafe-eval' (in-app previews only;
 *     published exports carry no CSP, unchanged). Fingerprint layout
 *     tokens gain +js / +3d suffixes for scripted sections.
 *   - Agent surface: design.templates responses carry the scripts
 *     block (registry + rules). The freestyle-section script ban
 *     (SECTION_SCRIPT) is untouched.
 *
 *   Part 1 — source pins.
 *   Part 2 — registry parity + specifier rules.
 *   Part 3 — validation matrix + model ops (siteStructure).
 *   Part 4 — BYTE-IDENTICAL DEFAULT: golden pins from the pristine
 *     Batch 198 engine (2b268c0).
 *   Part 5 — emission: wrappers, stamps, gates, template compose.
 *   Part 6 — save-path rejection (domain.validatePages).
 *   Part 7 — QA: section-scripts-valid passes clean, fails bad.
 *   Part 8 — export browser audit: the script pass (clean / throwing
 *     / lib-missing / off-allowlist host). Skips without a browser.
 *   Part 9 — fingerprint +js/+3d suffixes.
 *   Part 10 — clone bake: exportStatic output keeps the script tags
 *     (the standalone clone generator bakes via exportStatic).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b199-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch199', 'test', 'session', 'secret'].join('-');
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
  const structure = require(path.join(root, 'src/siteStructure.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const engineSrc = read('src/websiteEngine.js');
    assert.ok(engineSrc.includes("require('./sectionScripts')"), 'engine requires sectionScripts');
    assert.ok(engineSrc.includes('injectSectionScripts'), 'engine injects section scripts');
    assert.ok(engineSrc.includes('data-bp-sec'), 'engine stamps data-bp-sec');
    assert.ok(engineSrc.includes("'section-scripts-valid'"), 'engine QA carries section-scripts-valid');
    n += 4;
    const domainSrc = read('server/domain.js');
    for (const key of ["'js'", "'libs'", "'jsModule'", "'jsExpect'"]) {
      assert.ok(domainSrc.includes(key), `SECTION_TOP_KEYS carries ${key}`);
    }
    assert.ok(domainSrc.includes('validateSectionScript(s)'), 'domain validatePages validates section scripts');
    assert.ok(domainSrc.includes('SECTION_SCRIPT'), 'the freestyle-section script ban is untouched');
    n += 6;
    const ipcSrc = read('src/ipc/websites.js');
    assert.ok(ipcSrc.includes('validateSectionScript(s)'), 'ipc mirror validates section scripts');
    const djSrc = read('src/designJobs.js');
    assert.ok(djSrc.includes('validateSectionScripts'), 'designJobs re-checks section scripts');
    const chatSrc = read('server/portalSiteChat.js');
    assert.ok(chatSrc.includes('validateSectionScripts'), 'portalSiteChat re-checks section scripts');
    n += 3;
    const previewSrc = read('server/previewSecurity.js');
    assert.ok(previewSrc.includes("'wasm-unsafe-eval'"), 'preview CSP allows WASM eval');
    const qaSrc = read('server/spacingQa.js');
    assert.ok(qaSrc.includes('measureSectionScriptsInPage'), 'spacingQa has the script measurement');
    assert.ok(qaSrc.includes('auditScriptPass'), 'spacingQa has the script pass');
    const fpSrc = read('server/siteFingerprint.js');
    assert.ok(fpSrc.includes("'+3d'") && fpSrc.includes("'+js'"), 'fingerprint carries the +js/+3d suffixes');
    n += 4;
    const mcpSrc = read('server/mcp.js');
    assert.ok(mcpSrc.includes('scriptsSummary()'), 'design.templates serves the scripts summary');
    assert.ok(mcpSrc.includes('section.js'), 'design.templates description names section.js');
    n += 2;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — registry parity + specifier rules                          */
  /* ================================================================== */
  {
    let n = 0;
    const ids = scriptLibs.libIds();
    assert.deepEqual(ids.slice().sort(), ['gsap', 'three'], 'v1 registry is three + gsap');
    n++;
    for (const lib of scriptLibs.LIBS) {
      for (const field of [
        'id',
        'label',
        'description',
        'bestFor',
        'version',
        'url',
        'integrity',
        'kind',
        'bytesGzip',
      ]) {
        assert.ok(lib[field] != null && lib[field] !== '', `lib ${lib.id}: ${field} present`);
        n++;
      }
      assert.ok(/^https:\/\/cdn\.jsdelivr\.net\//.test(lib.url), `lib ${lib.id}: pinned jsDelivr URL`);
      assert.ok(/^sha384-/.test(lib.integrity), `lib ${lib.id}: SRI sha384 recorded`);
      assert.ok(Number(lib.bytesGzip) > 0, `lib ${lib.id}: gzip size recorded`);
      n += 3;
      if (lib.kind === 'classic') {
        assert.ok(typeof lib.global === 'string' && lib.global.length > 0, `lib ${lib.id}: classic global named`);
        n++;
      } else {
        assert.equal(lib.kind, 'module', `lib ${lib.id}: kind is classic|module`);
        assert.ok(lib.importMap && Object.keys(lib.importMap).length > 0, `lib ${lib.id}: importMap present`);
        n += 2;
      }
    }
    assert.equal(scriptLibs.getLib('three').version, '0.160.0', 'three is pinned at 0.160.0');
    assert.equal(scriptLibs.getLib('gsap').global, 'gsap', 'gsap global is window.gsap');
    assert.ok(scriptLibs.registryHosts().includes('cdn.jsdelivr.net'), 'registry hosts derive from the pinned URLs');
    n += 3;
    assert.equal(scriptLibs.isRegistrySpecifier('three'), true, 'bare three resolves');
    assert.equal(scriptLibs.isRegistrySpecifier('three/addons/controls/OrbitControls.js'), true, 'addons resolve');
    assert.equal(scriptLibs.isRegistrySpecifier('three/addons/'), false, 'bare addons prefix does not resolve');
    assert.equal(
      scriptLibs.isRegistrySpecifier('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'),
      false,
      'URLs never resolve as specifiers'
    );
    assert.equal(scriptLibs.isRegistrySpecifier('lodash'), false, 'unregistered specifiers do not resolve');
    assert.equal(scriptLibs.isRegistrySpecifier('./local.js'), false, 'relative specifiers do not resolve');
    n += 6;
    group('Part 2 — registry parity', n);
  }

  /* ================================================================== */
  /* Part 3 — validation matrix + model ops                              */
  /* ================================================================== */
  {
    let n = 0;
    const V = (section) => sectionScripts.validateSectionScript(section);
    const codes = (section) => V(section).map((p) => p.code);
    // Valid sets pass clean.
    assert.deepEqual(V({ type: 'hero', content: {}, js: 'el.dataset.on = "1";' }), [], 'plain classic script valid');
    assert.deepEqual(
      V({ type: 'hero', content: {}, js: 'gsap.to(el, { opacity: 1 });', libs: ['gsap'] }),
      [],
      'classic + gsap valid'
    );
    assert.deepEqual(
      V({
        type: 'hero',
        content: {},
        js: 'import * as THREE from "three";\nvar s = new THREE.Scene();',
        libs: ['three'],
        jsModule: true,
      }),
      [],
      'module + three valid'
    );
    assert.deepEqual(
      V({ type: 'text', content: {}, js: 'el.dataset.x = "1";', jsExpect: 'canvas.bp-3d' }),
      [],
      'jsExpect valid'
    );
    assert.deepEqual(V({ type: 'hero', content: {} }), [], 'script-free section has nothing to validate');
    n += 5;
    // Availability fence mirrors Part A.
    assert.ok(codes({ type: 'nav', content: {}, js: 'var x = 1;' }).includes('SCRIPT_NOT_AVAILABLE'), 'nav fenced');
    assert.ok(
      codes({ type: 'site_module', content: {}, js: 'var x = 1;' }).includes('SCRIPT_NOT_AVAILABLE'),
      'site_module fenced'
    );
    assert.ok(
      codes({ type: 'columns', content: {}, js: 'var x = 1;' }).includes('SCRIPT_NOT_AVAILABLE'),
      'columns fenced'
    );
    n += 3;
    // Denylist — each rule rejects and names itself in the message.
    const denyCases = [
      ['eval("1")', /eval/],
      ['var f = new Function("return 1");', /Function/],
      ['document.write("x");', /document\.write/],
      ['var c = document.cookie;', /cookie/],
      ['var s = document.createElement("script");', /script injection/],
      ['fetch("/api/v1/leads");', /\/api\/v1\//],
      ['var s = "</scr" + "ipt>"; var t = "</script>";', /script/],
      ['import("https://evil.example/x.js");', /registry/],
      ['var m = import(name);', /string literal/],
    ];
    for (const [code, re] of denyCases) {
      const problems = V({ type: 'hero', content: {}, js: code });
      assert.ok(
        problems.some((p) => p.code === 'SECTION_JS_DENIED' && re.test(p.message)),
        `denylist rejects: ${code.slice(0, 34)}`
      );
      n++;
    }
    // Syntax errors name the problem.
    const syn = V({ type: 'hero', content: {}, js: 'var x = ;' });
    assert.ok(
      syn.some((p) => p.code === 'SECTION_JS_SYNTAX' && /syntax/i.test(p.message)),
      'classic syntax error named'
    );
    const synM = V({
      type: 'hero',
      content: {},
      js: 'import * as THREE from "three";\nvar x = ;',
      libs: ['three'],
      jsModule: true,
    });
    assert.ok(
      synM.some((p) => p.code === 'SECTION_JS_SYNTAX'),
      'module syntax error named'
    );
    n += 2;
    // Caps.
    const big = 'var a = 1; /*' + 'x'.repeat(sectionScripts.MAX_SECTION_JS_CHARS) + '*/';
    assert.ok(codes({ type: 'hero', content: {}, js: big }).includes('SECTION_JS_TOO_LONG'), 'section cap enforced');
    n++;
    // Libs coherence.
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', libs: ['lodash'] }).includes('UNKNOWN_LIB'),
      'unknown lib named'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', libs: ['gsap', 'gsap'] }).includes('INVALID_LIBS'),
      'duplicate lib rejected'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', libs: ['three'] }).includes('LIB_KIND_MISMATCH'),
      'classic + three rejected'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', jsModule: true }).includes('MODULE_LIB_REQUIRED'),
      'module without a module lib rejected'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', jsModule: false }).includes('INVALID_JS_MODULE'),
      'stored jsModule:false rejected'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, libs: ['gsap'] }).includes('INVALID_SECTION_JS'),
      'libs without js rejected'
    );
    n += 6;
    // Imports: registry-only + declared.
    const undeclared = V({
      type: 'hero',
      content: {},
      js: 'import * as THREE from "three";',
      libs: ['gsap'],
      jsModule: true,
    });
    assert.ok(
      undeclared.some((p) => p.code === 'IMPORT_NOT_DECLARED' || p.code === 'MODULE_LIB_REQUIRED'),
      'undeclared import rejected'
    );
    const foreign = V({ type: 'hero', content: {}, js: 'import _ from "lodash";', libs: ['three'], jsModule: true });
    assert.ok(
      foreign.some((p) => p.code === 'IMPORT_NOT_REGISTRY'),
      'foreign specifier rejected'
    );
    const late = V({
      type: 'hero',
      content: {},
      js: 'var x = 1;\nimport * as THREE from "three";',
      libs: ['three'],
      jsModule: true,
    });
    assert.ok(
      late.some((p) => p.code === 'SECTION_JS_SYNTAX' && /top/.test(p.message)),
      'late import rejected with guidance'
    );
    n += 3;
    // jsExpect shape.
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', jsExpect: 'a'.repeat(121) }).includes('INVALID_JS_EXPECT'),
      'jsExpect cap enforced'
    );
    assert.ok(
      codes({ type: 'hero', content: {}, js: 'var x = 1;', jsExpect: '<canvas>' }).includes('INVALID_JS_EXPECT'),
      'jsExpect angle brackets rejected'
    );
    n += 2;
    // Model ops: round-trip + clear.
    const sec = { type: 'hero', content: {} };
    structure.setSectionJs(sec, { js: 'el.dataset.on = "1";', libs: ['gsap'], jsExpect: 'canvas' });
    assert.equal(sec.js, 'el.dataset.on = "1";', 'setter stores js');
    assert.deepEqual(sec.libs, ['gsap'], 'setter stores libs');
    assert.equal(sec.jsExpect, 'canvas', 'setter stores jsExpect');
    assert.equal(structure.hasSectionJs(sec), true, 'hasSectionJs true');
    assert.equal(structure.getSectionJs(sec), sec.js, 'getSectionJs round-trips');
    n += 5;
    assert.throws(
      () => structure.setSectionJs({ type: 'hero', content: {} }, { js: 'eval("1")' }),
      (e) => e.code === 'SECTION_JS_DENIED',
      'setter refuses a denied script with the code'
    );
    n++;
    structure.setSectionJs(sec, { js: '' });
    assert.ok(
      !('js' in sec) && !('libs' in sec) && !('jsExpect' in sec) && !('jsModule' in sec),
      'clearing deletes all four fields'
    );
    n++;
    // Save-path validator + per-page cap.
    const pageSections = [
      { type: 'hero', content: {}, js: 'var a = "' + 'x'.repeat(49000) + '";' },
      { type: 'text', content: {}, js: 'var b = "' + 'x'.repeat(49000) + '";' },
      { type: 'faq', content: {}, js: 'var c = "' + 'x'.repeat(49000) + '";' },
      { type: 'cta', content: {}, js: 'var d = "' + 'x'.repeat(49000) + '";' },
    ];
    const pageProblems = structure.validateSectionScripts(pageSections);
    assert.ok(
      pageProblems.some((p) => p.code === 'PAGE_JS_TOO_LONG'),
      'per-page cap enforced by the save-path validator'
    );
    assert.deepEqual(
      structure.validateSectionScripts([{ type: 'hero', content: {}, js: 'var ok = 1;' }]),
      [],
      'clean page validates empty'
    );
    n += 2;
    group('Part 3 — validation matrix + model ops', n);
  }

  /* ================================================================== */
  /* Part 4 — byte-identical default (golden pins from 2b268c0)          */
  /* ================================================================== */
  {
    let n = 0;
    const pages = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          {
            type: 'nav',
            content: {
              business_name: 'Golden Biz',
              links: [
                { label: 'Home', href: '#home' },
                { label: 'FAQ', href: '#faq' },
              ],
            },
          },
          {
            type: 'hero',
            content: { headline: 'Golden Headline', subheadline: 'Golden sub', cta_text: 'Call', cta_href: '#contact' },
          },
          {
            type: 'faq',
            content: {
              title: 'Questions',
              items: [
                { q: 'Q1?', a: 'A1.' },
                { q: 'Q2?', a: 'A2.' },
              ],
            },
          },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const full = engine.renderPage(pages[0], pages, THEME, {});
    assert.equal(
      sha256(full),
      '07f1cca3c8eea194e265b922b1ed4eb90b4b229fb75a4f9f7a1b93630e38c9cd',
      'script-free page renders byte-identically to Batch 198'
    );
    assert.ok(
      !/data-bp-sec|data-ws-section-js|data-bp-lib|importmap/.test(full),
      'no Batch 199 markers on a script-free page'
    );
    n += 2;
    const templated = [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'nav', content: { business_name: 'Golden Biz', links: [{ label: 'Home', href: '#home' }] } },
          {
            type: 'faq',
            content: { title: 'Questions', items: [{ q: 'Q1?', a: 'A1.' }] },
            template: '<div class="g-faq"><h2>{{title}}</h2>{{#items}}<p>{{q}} — {{a}}</p>{{/items}}</div>',
          },
          { type: 'footer', content: {} },
        ],
      },
    ];
    assert.equal(
      sha256(engine.renderPage(templated[0], templated, THEME, {})),
      '655a0f91d33faeb9130c8bd33985d8c10feb7f2ade89f24e137bf746bc9735a4',
      'templated (script-free) page renders byte-identically to Batch 198'
    );
    n++;
    assert.equal(
      sha256(engine.sectionToHtml({ type: 'hero', content: { headline: 'H', subheadline: 'S' } }, THEME, null)),
      '488c7b6a7e35db6b0e6998bcaa2dc402cab85c3f338fe118f542ec056775b28c',
      'script-free section renders byte-identically to Batch 198'
    );
    n++;
    group('Part 4 — byte-identical default', n);
  }

  /* ================================================================== */
  /* Part 5 — emission                                                   */
  /* ================================================================== */
  {
    let n = 0;
    const nav = { type: 'nav', content: { business_name: 'B199 Biz', links: [{ label: 'Home', href: '#home' }] } };
    const foot = { type: 'footer', content: {} };
    // Classic + gsap.
    const classicPage = {
      slug: 'index',
      title: 'Home',
      sections: [
        nav,
        {
          type: 'hero',
          content: { headline: 'Hi', subheadline: 'Sub' },
          js: 'el.dataset.on = "1";',
          libs: ['gsap'],
          jsExpect: 'canvas.stage',
        },
        foot,
      ],
    };
    const classicHtml = engine.renderPage(classicPage, [classicPage], THEME, {});
    assert.ok(classicHtml.includes('data-bp-sec="p0-s1"'), 'visitor render stamps the section key');
    assert.ok(classicHtml.includes('data-bp-js-expect="canvas.stage"'), 'visitor render stamps jsExpect');
    assert.ok(
      classicHtml.includes('<script data-ws-section-js="1" data-ws-section-type="hero" data-bp-sec-ref="p0-s1">'),
      'section script tag emitted'
    );
    assert.ok(classicHtml.includes('querySelector(\'[data-bp-sec="p0-s1"]\')'), 'wrapper binds root by section key');
    assert.ok(classicHtml.includes('try {'), 'wrapper carries try/catch');
    assert.ok(classicHtml.includes('data-bp-js-error'), 'wrapper stamps the error mark on throw');
    assert.ok(classicHtml.includes('data-bp-js-skipped'), 'wrapper stamps the lib-missing skip mark');
    assert.ok(classicHtml.includes("typeof window.gsap === 'undefined'"), 'classic wrapper probes the declared global');
    n += 8;
    const gsap = scriptLibs.getLib('gsap');
    assert.ok(
      classicHtml.includes(`<script src="${gsap.url}" integrity="${gsap.integrity}" crossorigin="anonymous"`) &&
        classicHtml.includes('data-bp-lib="gsap"'),
      'gsap emits the pinned tag with SRI'
    );
    assert.ok(classicHtml.includes('data-bp-lib-error'), 'lib tag stamps an error mark on load failure');
    n += 2;
    // Module + three, shared by two sections → ONE importmap.
    const moduleSections = [
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
        js: 'import * as THREE2 from "three";\nwindow.__b = 1;',
        libs: ['three'],
        jsModule: true,
      },
      foot,
    ];
    const modulePage = { slug: 'index', title: 'Home', sections: moduleSections };
    const moduleHtml = engine.renderPage(modulePage, [modulePage], THEME, {});
    const importmaps = moduleHtml.split('<script type="importmap"').length - 1;
    assert.equal(importmaps, 1, 'importmap emitted exactly once for shared three');
    assert.ok(
      moduleHtml.includes('"three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"'),
      'importmap carries the addons prefix'
    );
    assert.equal(
      (moduleHtml.match(/<script type="module" data-ws-section-js="1"/g) || []).length,
      2,
      'both module scripts emitted'
    );
    assert.ok(
      moduleHtml.includes('data-bp-sec-ref="p0-s1">import * as THREE from "three";'),
      'imports hoist to the top of their module tag, above the wrapper'
    );
    n += 4;
    // Portal edit canvas: nothing.
    const editable = engine.renderPage(classicPage, [classicPage], THEME, { editable: true });
    assert.ok(
      !/data-ws-section-js|data-bp-lib|data-bp-sec|importmap/.test(editable),
      'edit canvas receives no scripts, libs, stamps or importmap'
    );
    n++;
    // Template + script compose.
    const composed = {
      slug: 'index',
      title: 'Home',
      sections: [
        nav,
        {
          type: 'faq',
          content: { title: 'Q', items: [{ q: 'Q?', a: 'A.' }] },
          template: '<div class="c-faq"><h2>{{title}}</h2>{{#items}}<p>{{q}}</p>{{/items}}</div>',
          js: 'el.dataset.on = "1";',
        },
        foot,
      ],
    };
    const composedHtml = engine.renderPage(composed, [composed], THEME, {});
    assert.ok(composedHtml.includes('data-template="custom"'), 'template stamp kept');
    assert.ok(composedHtml.includes('data-bp-sec="p0-s1"'), 'script stamp added on the templated root');
    assert.ok(composedHtml.includes('data-ws-section-js="1"'), 'script emitted alongside the template');
    n += 3;
    group('Part 5 — emission', n);
  }

  /* ================================================================== */
  /* Part 6 — save-path rejection                                        */
  /* ================================================================== */
  {
    let n = 0;
    const domain = require(path.join(root, 'server/domain.js'));
    const base = () => [
      {
        slug: 'index',
        title: 'Home',
        sections: [
          { type: 'nav', content: { business_name: 'B199' } },
          { type: 'hero', content: { headline: 'H' } },
          { type: 'footer', content: {} },
        ],
      },
    ];
    const denied = base();
    denied[0].sections[1].js = 'var c = document.cookie;';
    assert.throws(
      () => domain.validatePages(denied),
      (e) => e.code === 'SECTION_JS_DENIED' && /cookie/.test(e.message),
      'save rejects document.cookie naming the rule'
    );
    n++;
    const unknownLib = base();
    unknownLib[0].sections[1].js = 'var x = 1;';
    unknownLib[0].sections[1].libs = ['threejs-cdn'];
    assert.throws(
      () => domain.validatePages(unknownLib),
      (e) => e.code === 'UNKNOWN_LIB' && /threejs-cdn/.test(e.message),
      'save rejects an agent-chosen library naming it'
    );
    n++;
    const fenced = base();
    fenced[0].sections[0].js = 'var x = 1;';
    assert.throws(
      () => domain.validatePages(fenced),
      (e) => e.code === 'SCRIPT_NOT_AVAILABLE' && /nav/.test(e.message),
      'save fences scripts off chrome'
    );
    n++;
    const clean = base();
    clean[0].sections[1].js = 'el.dataset.on = "1";';
    clean[0].sections[1].libs = ['gsap'];
    assert.doesNotThrow(() => domain.validatePages(clean), 'a valid scripted page saves');
    n++;
    group('Part 6 — save-path rejection', n);
  }

  /* ================================================================== */
  /* Setup for Parts 7 + 10 — fixture workspace + site                   */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const acct = await workspace.createUserWithWorkspace({
    email: 'a199@example.invalid',
    password: ['B199', 'Fixture', 'Pw', '7788'].join('-'),
    name: 'A199',
    workspaceName: 'Batch199 WS',
  });
  const WS_ID = Number(acct.workspaceId);
  const LEAD_A = 199001;
  const db = openWorkspaceDb(WS_ID);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B199 Fixture Studio',
    'b199@example.invalid',
    'customer'
  );
  const pages199 = [
    {
      slug: 'index',
      title: 'Home',
      sections: [
        { type: 'nav', content: { business_name: 'B199 Fixture Studio' } },
        {
          type: 'hero',
          content: { headline: 'Fixture', subheadline: 'Proof' },
          js: 'el.dataset.on = "1";',
          libs: ['gsap'],
        },
        { type: 'footer', content: {} },
      ],
    },
  ];
  const siteInfo = db
    .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
    .run(LEAD_A, 'B199 Fixture Studio', 'draft', JSON.stringify(pages199), JSON.stringify(THEME));
  const SITE_A = Number(siteInfo.lastInsertRowid);

  /* ================================================================== */
  /* Part 7 — QA section-scripts-valid                                   */
  /* ================================================================== */
  {
    let n = 0;
    const clean = await engine.qaSite(db, SITE_A);
    const cClean = (clean.checks || []).find((c) => c.name === 'section-scripts-valid');
    assert.ok(cClean, 'QA carries the script check');
    assert.equal(cClean.pass, true, 'QA passes a site whose scripts validate');
    n += 2;
    const badPages = JSON.parse(JSON.stringify(pages199));
    badPages[0].sections[1].js = 'eval("1");';
    db.prepare('UPDATE websites SET pages = ? WHERE id = ?').run(JSON.stringify(badPages), SITE_A);
    const bad = await engine.qaSite(db, SITE_A);
    const cBad = (bad.checks || []).find((c) => c.name === 'section-scripts-valid');
    assert.ok(cBad, 'QA carries the script check on the bad site');
    assert.equal(cBad.pass, false, 'QA fails a hand-edited denied script');
    assert.ok(/eval/.test(cBad.detail), 'QA names the denied construct');
    n += 3;
    db.prepare('UPDATE websites SET pages = ? WHERE id = ?').run(JSON.stringify(pages199), SITE_A);
    group('Part 7 — QA script check', n);
  }

  /* ================================================================== */
  /* Part 8 — export browser audit: the script pass                      */
  /* ================================================================== */
  {
    let n = 0;
    const spacingQa = require(path.join(root, 'server/spacingQa.js'));
    assert.equal(typeof spacingQa.measureSectionScriptsInPage, 'function', 'spacingQa exports the script measurement');
    n++;
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b199-export-'));
    const navS = { type: 'nav', content: { business_name: 'B199 Audit' } };
    const footS = { type: 'footer', content: {} };
    // clean: script creates its jsExpect target inside the root.
    const cleanPage = {
      slug: 'index',
      title: 'Home',
      sections: [
        navS,
        {
          type: 'hero',
          content: { headline: 'Clean', subheadline: 'Run' },
          js: 'var d = document.createElement("div"); d.id = "made-by-js"; d.textContent = "ran"; d.style.width = "40px"; d.style.height = "20px"; el.appendChild(d);',
          jsExpect: '#made-by-js',
        },
        footS,
      ],
    };
    fs.writeFileSync(path.join(exportDir, 'clean.html'), engine.renderPage(cleanPage, [cleanPage], THEME, {}));
    // throwing: the wrapper catches, stamps, and QA flags it.
    const throwPage = {
      slug: 'index',
      title: 'Home',
      sections: [navS, { type: 'hero', content: { headline: 'Boom' }, js: 'throw new Error("b199 boom");' }, footS],
    };
    fs.writeFileSync(path.join(exportDir, 'throwing.html'), engine.renderPage(throwPage, [throwPage], THEME, {}));
    // lib-missing: gsap declared but the lib tag stripped by hand.
    const gsapPage = {
      slug: 'index',
      title: 'Home',
      sections: [
        navS,
        { type: 'hero', content: { headline: 'NoLib' }, js: 'gsap.to(el, { opacity: 0.5 });', libs: ['gsap'] },
        footS,
      ],
    };
    const gsapHtml = engine
      .renderPage(gsapPage, [gsapPage], THEME, {})
      .replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^>]*data-bp-lib="gsap"[^>]*><\/script>/, '');
    assert.ok(!gsapHtml.includes('data-bp-lib="gsap"'), 'fixture: lib tag stripped');
    fs.writeFileSync(path.join(exportDir, 'libmiss.html'), gsapHtml);
    // off-allowlist: theme customJs (the Batch 152 channel) injects a
    // script from a host the page never declares statically.
    const offTheme = {
      ...THEME,
      customJs:
        'var s = document.createElement("script"); s.src = "https://unpkg.com/lodash@4.17.21/lodash.min.js"; document.head.appendChild(s);',
    };
    const offPage = {
      slug: 'index',
      title: 'Home',
      sections: [navS, { type: 'hero', content: { headline: 'Off' } }, footS],
    };
    fs.writeFileSync(path.join(exportDir, 'offhost.html'), engine.renderPage(offPage, [offPage], offTheme, {}));
    let audit = null;
    let auditErr = null;
    try {
      audit = await spacingQa.assessExportedFiles(
        { dir: exportDir, files: ['clean.html', 'throwing.html', 'libmiss.html', 'offhost.html'] },
        { widths: [390] }
      );
    } catch (e) {
      auditErr = e;
    }
    if (audit) {
      const scriptV = (audit.violations || []).filter((v) => v.kind === 'script');
      assert.ok(!scriptV.some((v) => v.page === 'clean.html'), 'the clean scripted page draws no script violations');
      n++;
      // Batch 200 instrument fix (same pattern as the batch115/173
      // hardenings — assertion INTENT unchanged): audit violations
      // carry their message in `text`, never `detail`, and the stamp
      // violations name the section in `selector` with the reason in
      // `text` ("section script (hero) threw at runtime" /
      // "skipped: lib-missing"). The original haystacks (selector +
      // detail) could never match either stamp, so these assertions
      // only ever passed while Part 8 was being skipped wholesale
      // under the old 60s audit budget. Match selector + text, the
      // fields the audit actually emits.
      assert.ok(
        scriptV.some(
          (v) => v.page === 'throwing.html' && /threw|pageerror/i.test(`${v.selector || ''} ${v.text || ''}`)
        ),
        'a throwing script is flagged'
      );
      n++;
      assert.ok(
        scriptV.some((v) => v.page === 'libmiss.html' && /lib-missing/.test(`${v.selector || ''} ${v.text || ''}`)),
        'a missing declared library is flagged'
      );
      n++;
      assert.ok(
        scriptV.some((v) => v.page === 'offhost.html' && /unpkg\.com/.test(v.selector || '')),
        'an off-allowlist script host is flagged by name'
      );
      n++;
      assert.ok(
        (audit.violations || []).filter((v) => v.page === 'clean.html').length === 0,
        'the clean page is fully clean (geometry + hooks + scripts)'
      );
      n++;
    } else {
      console.log(`  (Part 8 browser audit skipped locally: ${auditErr && (auditErr.code || auditErr.message)})`);
    }
    group('Part 8 — export browser audit', n);
  }

  /* ================================================================== */
  /* Part 9 — fingerprint suffixes                                       */
  /* ================================================================== */
  {
    let n = 0;
    const fingerprint = require(path.join(root, 'server/siteFingerprint.js'));
    const plain = fingerprint.computeFingerprint({
      theme: THEME,
      pages: [{ slug: 'index', sections: [{ type: 'hero', content: {} }] }],
    });
    assert.deepEqual(plain.layout.pages[0].sections, ['hero'], 'script-free hero token unchanged');
    n++;
    const withJs = fingerprint.computeFingerprint({
      theme: THEME,
      pages: [{ slug: 'index', sections: [{ type: 'hero', content: {}, js: 'var x = 1;' }] }],
    });
    assert.deepEqual(withJs.layout.pages[0].sections, ['hero+js'], 'scripted hero gains +js');
    n++;
    const with3d = fingerprint.computeFingerprint({
      theme: THEME,
      pages: [
        { slug: 'index', sections: [{ type: 'hero', content: {}, js: 'var x = 1;', libs: ['three'], jsModule: true }] },
      ],
    });
    assert.deepEqual(with3d.layout.pages[0].sections, ['hero+3d'], 'three hero gains +3d');
    n++;
    assert.notEqual(plain.layoutHash, withJs.layoutHash, 'scripted and unscripted layouts hash differently');
    n++;
    group('Part 9 — fingerprint suffixes', n);
  }

  /* ================================================================== */
  /* Part 10 — clone bake keeps the tags (exportStatic)                  */
  /* ================================================================== */
  {
    let n = 0;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b199-clone-'));
    engine.exportStatic(db, SITE_A, outDir, {});
    const baked = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(baked.includes('data-ws-section-js="1"'), 'baked site carries the section script');
    assert.ok(baked.includes('data-bp-lib="gsap"'), 'baked site carries the pinned lib tag');
    assert.ok(baked.includes('data-bp-sec="p0-s1"'), 'baked site carries the section stamp');
    n += 3;
    group('Part 10 — clone bake', n);
  }

  console.log(`\nbatch199: all ${groups} groups passed`);
})().catch((e) => {
  console.error('batch199 FAILED:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
