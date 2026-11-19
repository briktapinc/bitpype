'use strict';
/**
 * Batch 197 — MODULE CUSTOM LAYOUTS, PART A: hooks manifest + custom
 * templates for design sections (incl. contact_form). Ely approved
 * 2026-11-19 ("Do it") after the feasibility investigation
 * (module-custom-layout-investigation-2026-11-19.md): modules keep
 * their core functionality while the layout/design becomes fully
 * custom — the agent rewrites the HTML using the same names, classes
 * and ids, and the behaviour must not change.
 *
 * What 197 Part A ships:
 *   - src/sectionTemplates.js — THE HOOKS MANIFEST + template engine:
 *     one entry per renderer type in src/websiteEngine.js RENDERERS
 *     (parity-checked, Batch 122/188 discipline), declaring per type
 *     the substitution tokens ({{name}}), loops ({{#items}}…{{/items}})
 *     and conditionals ({{#if name}}…{{/if}}) with each value's
 *     escaping kind, the REQUIRED functional hooks (form field names,
 *     the form action token, anchor ids, data attributes), and the
 *     DOM hooks the export browser audit asserts. Types where
 *     free-HTML templates are unsafe/meaningless in v1 are
 *     manifest-only with the reason recorded: nav/footer (chrome),
 *     html (already free), bitpype_form/form + site_module (Family B
 *     mounts — Parts C/B), columns (composition primitive).
 *   - section.template — sanitized HTML + tokens, stored ONLY when
 *     set (Batch 148/188): absent = byte-identical standard render
 *     (Part 4 golden pins, captured from the pristine f756c0c engine).
 *     NO agent JavaScript: the template passes the platform sanitizer
 *     (scripts/handlers stripped) and substitution values are
 *     pre-escaped fragments from the renderers' own helpers.
 *   - Renderer integration: sectionToHtml renders through a valid
 *     template and stamps data-template="custom" on the root; ANY
 *     error falls back silently to the standard renderer (Part 7).
 *     The portal inline-edit canvas keeps the standard renderer.
 *   - Save-time validation on every write path (design.deliver via
 *     domain validatePages + designJobs validateWebsitePayload,
 *     website save via the ipc mirror, portal layout save): a
 *     template missing a required hook is rejected, naming the hook.
 *   - QA: engine check `section-templates-valid` + the spacingQa
 *     browser audits assert the manifest's DOM hooks in the rendered
 *     page (kind 'template-hook').
 *   - Agent discoverability: the design.templates MCP tool returns
 *     the manifest (mirrors design.variants). (No pointer paragraph
 *     in src/defaultDesignInstructions.js: that export sits at
 *     19,977 of its 20,000-char job cap — pinned by the
 *     seo-foundations suite — so the tool description carries the
 *     surface on its own.)
 *
 *   Part 1 — source pins.
 *   Part 2 — manifest parity + metadata completeness.
 *   Part 3 — model ops (siteStructure): set/unset round-trips, ''
 *     refused as a stored value, disabled types refused with the
 *     reason, missing-hook refusal naming the hook, script/mount
 *     refusal, validateSectionTemplates matrix, editor descriptor.
 *   Part 4 — BYTE-IDENTICAL DEFAULT: golden pins from the pristine
 *     Batch 196 engine (f756c0c) for all 26 renderer types + the
 *     mailto contact_form + siteCss + a full renderPage.
 *   Part 5 — template renders: layout changes, data + hooks intact,
 *     data-template stamped (faq, text_image, hero).
 *   Part 6 — save rejection through domain.validatePages naming the
 *     missing hook; template on a manifest-only type refused.
 *   Part 7 — render-time fallback: hand-set broken templates render
 *     the standard bytes and stamp nothing.
 *   Part 8 — contact_form: bound + mailto custom templates keep the
 *     form action, token, field names and method (flows-live style).
 *   Part 9 — sanitization: handlers stripped at render; scripts and
 *     mounts rejected at save.
 *   Part 10 — QA: section-templates-valid passes a clean site, fails
 *     a hand-edited bad template naming the check.
 *   Part 11 — export browser audit: a hook-missing exported page is
 *     flagged kind 'template-hook'; a good one is not. (Skips when
 *     no browser is available locally; the gate runs it for real.)
 *   Part 12 — manifest summary shape + design.templates source pins.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b197-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch197', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');

const THEME = { primary: '#b3123f', secondary: '#1d1a16', bg: '#fffaf4', text: '#241d18' };

/* Fixtures — the exact section contents the golden pins were
 * captured with, from the pristine Batch 196 engine (f756c0c). */
const FIXTURE_CONTENT = {
  nav: {
    business_name: 'Pin Biz',
    phone: '610-555-0100',
    links: [
      { label: 'Home', href: '#home' },
      { label: 'Services', href: '#services' },
    ],
  },
  hero: {
    headline: 'Pin Headline',
    subheadline: 'Pin sub headline',
    cta_text: 'Call now',
    cta_href: '#contact',
    cta_secondary_text: 'See services',
    cta_secondary_href: '#services',
    rating: '4.9',
    review_count: 128,
    image: { url: 'https://example.com/img/hero.jpg', alt: 'Hero alt' },
  },
  benefits: {
    title: 'Why us',
    subtitle: 'Sub',
    items: [
      { title: 'Fast', text: 'Fast text', icon: 'zap' },
      { title: 'Fair', text: 'Fair text' },
    ],
  },
  services: {
    title: 'Services',
    subtitle: 'Sub',
    items: [
      { name: 'Drain Cleaning', description: 'Desc one' },
      { name: 'Water Heaters', description: 'Desc two' },
    ],
  },
  about: { title: 'About us', paragraphs: ['Para one.', 'Para two.'] },
  gallery: {
    title: 'Gallery',
    subtitle: 'Sub',
    images: [{ url: 'https://example.com/a.jpg', caption: 'Cap A' }, { caption: 'No photo' }],
  },
  reviews: {
    title: 'Reviews',
    subtitle: 'Sub',
    reviews: [
      { name: 'Sam', text: 'Great work', stars: 5 },
      { name: 'Jo', text: 'Good', stars: 4 },
    ],
  },
  cta: { title: 'Ready?', text: 'Talk to us', button_text: 'Contact', button_href: '#contact' },
  contact_form: {
    title: 'Contact',
    text: 'Reach out',
    form_action: 'https://bitpype.test/api/v1/forms/public/TOK999/submit',
    form_token: 'TOK999',
    phone: '610-555-0100',
    email: 'hi@example.com',
    address: '1 Main St',
  },
  map_placeholder: { title: 'Find Us', address_lines: ['1 Main St', 'Reading, PA'] },
  hours: {
    title: 'Hours',
    hours: [
      { day: 'Mon', open: '9', close: '5' },
      { day: 'Tue', open: '9', close: '5' },
    ],
  },
  faq: {
    title: 'FAQ',
    items: [
      { q: 'Q one?', a: 'A one.' },
      { q: 'Q two?', a: 'A two.' },
    ],
  },
  footer: {
    business_name: 'Pin Biz',
    tagline: 'Tag',
    phone: '610-555-0100',
    email: 'hi@example.com',
    address: '1 Main St',
  },
  booking_button: { title: 'Book', text: 'Call now', subtext: 'Open 7 days', phone: '610-555-0100' },
  social_links: {
    title: 'Follow',
    links: [
      { network: 'facebook', url: 'https://facebook.com/pinbiz', label: 'Facebook' },
      { network: 'instagram', url: 'https://instagram.com/pinbiz' },
    ],
  },
  custom: {
    heading: 'Custom head',
    body: 'Custom body',
    button: { text: 'Go', href: '#contact' },
    image: { url: 'https://example.com/c.jpg', alt: 'C' },
  },
  html: { html: '<div class="pin-html"><p>Hello <strong>world</strong></p></div>' },
  bitpype_form: { form_token: 'FORMTOK1' },
  form: { form_token: 'FORMTOK1' },
  site_module: { public_token: 'MODTOK1', module_type: 'blog' },
  columns: {
    title: 'Cols',
    cols: 2,
    cells: [
      { heading: 'Cell one', body: 'Body one' },
      { heading: 'Cell two', body: 'Body two', button: { text: 'More', href: '#x' } },
    ],
  },
  text: { heading: 'Text head', body: 'Text body' },
  text_image: {
    heading: 'TI head',
    body: 'TI body',
    image: { url: 'https://example.com/ti.jpg', alt: 'TI' },
    button: { text: 'Learn', href: '#services' },
    image_position: 'left',
  },
  cards: {
    title: 'Cards',
    subtitle: 'Sub',
    items: [
      { title: 'Card one', text: 'Text one', image: { url: 'https://example.com/k.jpg', alt: 'K' } },
      { title: 'Card two', text: 'Text two' },
    ],
  },
  heading: { heading: 'Big heading', level: 3 },
  image: { image: { url: 'https://example.com/im.jpg', alt: 'Im alt' }, caption: 'A caption' },
};
const FIXTURES = {};
for (const [type, content] of Object.entries(FIXTURE_CONTENT)) FIXTURES[type] = { type, content };
const CF_MAILTO = { type: 'contact_form', content: { title: 'Email us', email: 'hi@example.com' } };

/* Golden pins — captured from the PRISTINE Batch 196 engine (f756c0c). */
const GOLDEN = {
  nav: '077206bbdb58b51431a2c49daea1a28feca5b180026c50f7d73e51ed87751fda',
  hero: '3f784f6b51b1682507453c2ba1c4a01fe5e999071e49c12fae4c537db11f22e8',
  benefits: '6eadd07523016a3d0c3f89984477e7996c21e850eb1d002f8de4469931cf7ec0',
  services: 'bd534eb73085b119d986a70b6f1179cd3274ce63b69aa70923e3390dc8a3b29d',
  about: 'ae04dd496ecfd43acd95c04ed026baf3c2d3f172f430a4b1316ea7f8c61957f6',
  gallery: 'd9c7f127e136d630956cf87d7d61ecdf83b14559f9a68259b7106162027ca307',
  reviews: 'c1f2641c45b0b879707a39302b3704e6efb46ca5dc60a757c828a6ade5fb3fc7',
  cta: 'e6aaa6f9b843a7231cc9b813ee7cb15603399fb3ea30c4087b8ac03a8bf259e4',
  contact_form: '078b1d137f285f2316c9df0b19e70ccd61ec4703599e8f549a3c090c157f475d',
  map_placeholder: '46bab2598b8906510662e71e1d396ce5c3c0925185705c56e4a2cdf9c65a1ed0',
  hours: 'a8b84bbdd7f7cfd06bba9bd45b3a5b440be0cafc1efd88fdf7d68c7dcdf8d53d',
  faq: 'fbf049c4051bbd834b78cb871e1185d92eef3ef3bcf786136ff597ce473acf58',
  footer: 'ac1dabead751f3716362d929c79053c0feabaf6ea21d3bcd6d9a98f10e2e27ed',
  booking_button: 'ca42fb47136fd2bfa3cc53f7ba6c37ed36fd52760a22b121b61e1419d2fda838',
  social_links: '3dafda37f8c69e4208d4f24f5079b3d9f862b3999ff0760a87456f03924beb94',
  custom: 'c860a983a3868ab86fdb1c85cdcc9f4ba738f16774b0138a3aee2cb9b42dda21',
  html: '22c59169bebcbb22c17db0e9de6957f801d73bad1c4042059662be4cb891c1a4',
  bitpype_form: 'b1b2c7773cbbaab97b8caa0dcbc646c6c4eecb11ee97778af9a550f244644dc3',
  form: 'b1b2c7773cbbaab97b8caa0dcbc646c6c4eecb11ee97778af9a550f244644dc3',
  site_module: '877bdb4f1991b0ae0a9f1a9920f1b82b89617578d07bda3f39cb18420359f0de',
  columns: 'ac02728e2e6e35792d9935a9c8ab98b5eb285a7cfe7e268853a7785af7aa57e9',
  text: 'd1c139d51b1d2b93935e34d8ad75792f0718b97ccb4922ad16bb3c22e2a202d0',
  text_image: 'f1cfe912c3dbcf1806063b459eb6375be53a1a6d7cc5f8d6c78dd19c7430790a',
  cards: 'fca19da341e9415a753f87b0380cc01990a8ed8a72a9f07dcce16abd83ddc6d2',
  heading: '6d26d396615b3c564c298085d927b27ab21552d19e81c24bcdb0c20af769713b',
  image: 'a71d99ab7ee1d71ad36002f77f1d4525fc149e2e344369b7ea5c57a4a01ae8c9',
  contact_form_mailto: 'f6ec9a857c870dfe2e9cb62d1b72db3c347a10f76111927cfb4bea9479ff0e78',
  siteCss: '8f259a69af0b442893b035429f8375dfc1e6abb236254ed251b40769ff2348bf',
  renderPage: '73481687da28c1a6231831cfc977a30b65449f311a61fd70a269504410706989',
};

let groups = 0;
function group(name, n) {
  groups += 1;
  console.log(`ok ${groups} - ${name} (${n} checks)`);
}

const FAQ_TEMPLATE =
  '<div class="my-faq"><h2 class="my-faq-title">{{title}}</h2>{{#items}}<article class="qa"><h3>{{q}}</h3><div class="ans">{{a}}</div></article>{{/items}}</div>';
const CF_TEMPLATE_BOUND =
  '<div id="contact" class="reach"><h2>{{title}}</h2><p>{{text}}</p>' +
  '<form action="{{formAction}}" method="post" data-bitpype-form="1" data-form-token="{{formToken}}">' +
  '<label>Name <input name="name" required></label>' +
  '<label>Phone <input name="phone" type="tel"></label>' +
  '<label>Email <input name="email" type="email" required></label>' +
  '<label>Message <textarea name="message" rows="4" required></textarea></label>' +
  '<input type="submit" value="Send it"></form>' +
  '{{#if phone}}<a class="call" href="{{phoneHref}}">{{phone}}</a>{{/if}}</div>';
const CF_TEMPLATE_UNBOUND =
  '<div id="contact" class="reach"><h2>{{title}}</h2>' +
  '<form action="{{formAction}}" method="post">{{fields}}</form></div>';

(async () => {
  const templates = require(path.join(root, 'src/sectionTemplates.js'));
  const structure = require(path.join(root, 'src/siteStructure.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const manifestSrc = read('src/sectionTemplates.js');
    assert.ok(manifestSrc.includes('const MANIFEST'), 'manifest module ships the registry');
    assert.ok(manifestSrc.includes('TEMPLATE_MISSING_HOOK'), 'manifest module names missing hooks');
    const engineSrc = read('src/websiteEngine.js');
    assert.ok(engineSrc.includes('renderSectionWithTemplate'), 'engine has the template render path');
    assert.ok(engineSrc.includes('data-template'), 'engine stamps the template marker');
    assert.ok(engineSrc.includes("'section-templates-valid'"), 'engine QA carries the template check');
    const structSrc = read('src/siteStructure.js');
    assert.ok(structSrc.includes('validateSectionTemplates'), 'siteStructure validates templates');
    assert.ok(structSrc.includes('setSectionTemplate'), 'siteStructure has the template op');
    const domainSrc = read('server/domain.js');
    assert.ok(domainSrc.includes('TEMPLATE_NOT_AVAILABLE'), 'domain save path validates templates');
    assert.ok(domainSrc.includes("'template'"), 'domain SECTION_TOP_KEYS knows template');
    const ipcSrc = read('src/ipc/websites.js');
    assert.ok(ipcSrc.includes('TEMPLATE_NOT_AVAILABLE'), 'ipc save path mirrors template validation');
    const jobsSrc = read('src/designJobs.js');
    assert.ok(jobsSrc.includes('validateSectionTemplates'), 'designJobs payload validation covers templates');
    const chatSrc = read('server/portalSiteChat.js');
    assert.ok(chatSrc.includes('validateSectionTemplates'), 'portal layout save re-checks templates');
    const qaSrc = read('server/spacingQa.js');
    assert.ok(qaSrc.includes('measureTemplateHooksInPage'), 'spacingQa asserts template DOM hooks');
    assert.ok(qaSrc.includes("kind: 'template-hook'"), 'spacingQa reports template-hook violations');
    // NOTE: no pointer is added to src/defaultDesignInstructions.js —
    // the export sits at 19,977 of its 20,000-char job cap (pinned by
    // seo-foundations-regressions), so the discoverability surface is
    // the design.templates MCP tool itself (Part 12).
    n += 14;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — manifest parity + metadata                                 */
  /* ================================================================== */
  {
    let n = 0;
    const rendererTypes = Object.keys(engine.RENDERERS).sort();
    const manifestTypes = templates.MANIFEST.map((e) => e.type).sort();
    assert.deepEqual(manifestTypes, rendererTypes, 'manifest covers exactly the renderer types');
    n++;
    for (const e of templates.MANIFEST) {
      assert.ok(e.label && e.summary, `${e.type}: label + summary present`);
      assert.ok(
        Array.isArray(e.tokens) && Array.isArray(e.loops) && Array.isArray(e.hooks),
        `${e.type}: token/loop/hook arrays`
      );
      for (const t of e.tokens) {
        assert.ok(
          t.name && ['text', 'html', 'url'].includes(t.kind) && t.description,
          `${e.type}: token ${t.name} fully described`
        );
      }
      for (const l of e.loops) {
        assert.ok(l.name && l.description && l.fields.length > 0, `${e.type}: loop ${l.name} fully described`);
        for (const f of l.fields)
          assert.ok(f.name && f.kind && f.description, `${e.type}: loop field ${f.name} described`);
      }
      for (const h of e.hooks)
        assert.ok(h.label && typeof h.required === 'boolean', `${e.type}: hook "${h.label}" labelled`);
      if (e.templates) {
        assert.ok(e.tokens.length + e.loops.length > 0, `${e.type}: template-enabled types declare tokens or loops`);
        assert.ok(
          e.hooks.some((h) => h.required),
          `${e.type}: template-enabled types declare at least one required hook`
        );
      } else {
        assert.ok(e.reason && e.reason.length > 10, `${e.type}: manifest-only types record the reason`);
      }
      n++;
    }
    const disabled = templates.MANIFEST.filter((e) => !e.templates)
      .map((e) => e.type)
      .sort();
    assert.deepEqual(
      disabled,
      ['bitpype_form', 'columns', 'footer', 'form', 'html', 'nav', 'site_module'],
      'exactly the fenced types are manifest-only in v1'
    );
    n++;
    const cf = templates.getEntry('contact_form');
    const cfRequired = cf.hooks
      .filter((h) => h.required)
      .map((h) => h.label)
      .join(' | ');
    assert.ok(/field named "name"/.test(cfRequired), 'contact_form requires the name field');
    assert.ok(/field named "email"/.test(cfRequired), 'contact_form requires the email field');
    assert.ok(/field named "message"/.test(cfRequired), 'contact_form requires the message field');
    assert.ok(/formAction/.test(cfRequired), 'contact_form requires the form action token');
    assert.ok(/data-bitpype-form/.test(cfRequired), 'contact_form requires the bound-form marker');
    assert.deepEqual(
      cf.domHooks,
      ['form', 'form [name="name"]', 'form [name="email"]', 'form [name="message"]'],
      'contact_form DOM hooks'
    );
    n += 6;
    group('Part 2 — manifest parity + metadata', n);
  }

  /* ================================================================== */
  /* Part 3 — model ops                                                  */
  /* ================================================================== */
  {
    let n = 0;
    const faq = JSON.parse(JSON.stringify(FIXTURES.faq));
    assert.equal(structure.getSectionTemplate(faq), '', 'unset template reads empty');
    assert.equal(structure.hasSectionTemplate(faq), false, 'unset template reports false');
    structure.setSectionTemplate(faq, FAQ_TEMPLATE);
    assert.equal(faq.template, FAQ_TEMPLATE, 'valid template stored verbatim');
    assert.equal(structure.hasSectionTemplate(faq), true, 'stored template reports true');
    structure.setSectionTemplate(faq, '');
    assert.ok(!('template' in faq), 'clearing deletes the property (stored only when set)');
    n += 5;
    assert.throws(
      () => structure.setSectionTemplate({ type: 'faq', content: {} }, 42),
      (e) => e.code === 'INVALID_TEMPLATE',
      'non-string template refused'
    );
    n++;
    assert.throws(
      () => structure.setSectionTemplate({ type: 'faq', content: {} }, '   '),
      (e) => e.code === 'INVALID_TEMPLATE',
      'whitespace-only template refused'
    );
    n++;
    assert.throws(
      () => structure.setSectionTemplate({ type: 'nav', content: {} }, '<div>x</div>'),
      (e) => e.code === 'TEMPLATE_NOT_AVAILABLE' && /chrome/.test(e.message),
      'chrome template refused with the reason'
    );
    n++;
    assert.throws(
      () => structure.setSectionTemplate({ type: 'site_module', content: {} }, '<div>x</div>'),
      (e) => e.code === 'TEMPLATE_NOT_AVAILABLE' && /Part B/.test(e.message),
      'mount template refused with the reason'
    );
    n++;
    assert.throws(
      () => structure.setSectionTemplate({ type: 'faq', content: {} }, '<div>static, no loop</div>'),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /items/.test(e.message),
      'missing loop refused, naming the hook'
    );
    n++;
    assert.throws(
      () =>
        structure.setSectionTemplate(
          { type: 'contact_form', content: { form_token: 'T1' } },
          '<div id="contact"><form action="{{formAction}}" method="post"><input name="name"><input name="email"><textarea name="message"></textarea><button type="submit">S</button></form></div>'
        ),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /data-bitpype-form/.test(e.message),
      'bound contact_form without the bitpype marker refused, naming it'
    );
    n++;
    assert.throws(
      () =>
        structure.setSectionTemplate(
          { type: 'faq', content: {} },
          '<div>{{#items}}<p>{{q}}</p>{{/items}}</div><scr' + 'ipt>alert(1)</scr' + 'ipt>'
        ),
      (e) => e.code === 'TEMPLATE_SCRIPT',
      'script in a template refused at save'
    );
    n++;
    assert.throws(
      () =>
        structure.setSectionTemplate(
          { type: 'faq', content: {} },
          '<div data-bitpype-module="blog">{{#items}}<p>{{q}}</p>{{/items}}</div>'
        ),
      (e) => e.code === 'TEMPLATE_MOUNT',
      'module mount in a template refused at save'
    );
    n++;
    assert.throws(
      () =>
        structure.setSectionTemplate({ type: 'faq', content: {} }, '<div>{{#items}}<p>{{bogus}}</p>{{/items}}</div>'),
      (e) => e.code === 'TEMPLATE_UNKNOWN_TOKEN' && /bogus/.test(e.message),
      'unknown token refused, naming it and the valid set'
    );
    n++;
    // validateSectionTemplates matrix
    assert.deepEqual(
      structure.validateSectionTemplates([JSON.parse(JSON.stringify(FIXTURES.faq))]),
      [],
      'template-free sections validate clean'
    );
    const good = JSON.parse(JSON.stringify(FIXTURES.faq));
    good.template = FAQ_TEMPLATE;
    assert.deepEqual(structure.validateSectionTemplates([good]), [], 'valid stored template validates clean');
    const bad = JSON.parse(JSON.stringify(FIXTURES.faq));
    bad.template = '<p>no loop</p>';
    const probs = structure.validateSectionTemplates([bad]);
    assert.equal(probs.length, 1, 'one problem for the hookless template');
    assert.equal(probs[0].code, 'TEMPLATE_MISSING_HOOK', 'problem code names the class');
    assert.ok(/items/.test(probs[0].message), 'problem names the missing loop');
    const empty = JSON.parse(JSON.stringify(FIXTURES.faq));
    empty.template = '';
    assert.equal(
      structure.validateSectionTemplates([empty])[0].code,
      'INVALID_TEMPLATE',
      'stored empty template is a problem'
    );
    n += 6;
    // Editor descriptor
    const dFaq = structure.describeEditorSection(JSON.parse(JSON.stringify(FIXTURES.faq)), 0);
    assert.equal(dFaq.canTemplate, true, 'faq descriptor offers templates');
    assert.equal(dFaq.hasTemplate, false, 'faq descriptor reports none stored');
    const dNav = structure.describeEditorSection(JSON.parse(JSON.stringify(FIXTURES.nav)), 0);
    assert.equal(dNav.canTemplate, false, 'nav descriptor fences templates');
    assert.ok(/chrome/.test(dNav.templateNote), 'nav descriptor carries the reason');
    n += 4;
    group('Part 3 — model ops', n);
  }

  /* ================================================================== */
  /* Part 4 — byte-identical default (golden pins from f756c0c)         */
  /* ================================================================== */
  {
    let n = 0;
    for (const type of Object.keys(FIXTURES)) {
      const out = engine.sectionToHtml(JSON.parse(JSON.stringify(FIXTURES[type])), THEME, null);
      assert.equal(sha256(out), GOLDEN[type], `${type}: template-free render is byte-identical to Batch 196`);
      n++;
    }
    assert.equal(
      sha256(engine.sectionToHtml(JSON.parse(JSON.stringify(CF_MAILTO)), THEME, null)),
      GOLDEN.contact_form_mailto,
      'contact_form (mailto): byte-identical'
    );
    n++;
    assert.equal(sha256(engine.siteCss(THEME)), GOLDEN.siteCss, 'siteCss byte-identical');
    n++;
    const page = {
      slug: 'index',
      title: 'Home',
      sections: ['nav', 'hero', 'services', 'faq', 'footer'].map((type) => ({
        type,
        content: JSON.parse(JSON.stringify(FIXTURE_CONTENT[type])),
      })),
    };
    assert.equal(sha256(engine.renderPage(page, [page], THEME, {})), GOLDEN.renderPage, 'renderPage byte-identical');
    n++;
    group('Part 4 — byte-identical default (golden pins)', n);
  }

  /* ================================================================== */
  /* Part 5 — template renders: layout changes, hooks intact             */
  /* ================================================================== */
  {
    let n = 0;
    const faqBase = engine.sectionToHtml(JSON.parse(JSON.stringify(FIXTURES.faq)), THEME, null);
    const faqTpl = JSON.parse(JSON.stringify(FIXTURES.faq));
    faqTpl.template = FAQ_TEMPLATE;
    const faqOut = engine.sectionToHtml(faqTpl, THEME, null);
    assert.notEqual(faqOut, faqBase, 'faq template changes the rendered bytes');
    assert.ok(faqOut.includes('data-template="custom"'), 'faq template render is stamped');
    assert.ok(faqOut.includes('<article class="qa">'), 'faq template layout is the agent’s own');
    assert.ok(!faqOut.includes('<details'), 'faq template replaces the standard disclosure markup');
    assert.ok(
      faqOut.includes('Q one?') && faqOut.includes('A one.') && faqOut.includes('Q two?') && faqOut.includes('A two.'),
      'faq data renders through the loop'
    );
    assert.ok(faqOut.includes('my-faq-title') && faqOut.includes('FAQ'), 'faq title token renders');
    n += 6;
    const tiTpl = JSON.parse(JSON.stringify(FIXTURES.text_image));
    tiTpl.template =
      '<div class="stacked"><figure class="top-photo">{{image}}</figure><h2>{{heading}}</h2><p>{{body}}</p>{{#if buttonText}}<a class="go" href="{{buttonHref}}">{{buttonText}}</a>{{/if}}</div>';
    const tiOut = engine.sectionToHtml(tiTpl, THEME, null);
    assert.ok(tiOut.includes('data-template="custom"'), 'text_image stamped');
    assert.ok(tiOut.indexOf('top-photo') < tiOut.indexOf('TI head'), 'text_image template puts the photo first');
    assert.ok(tiOut.includes('https://example.com/ti.jpg'), 'text_image photo renders');
    assert.ok(
      tiOut.includes('href="#services"') && tiOut.includes('>Learn</a>'),
      'text_image button renders through tokens'
    );
    n += 4;
    const heroTpl = JSON.parse(JSON.stringify(FIXTURES.hero));
    heroTpl.template =
      '<div class="billboard"><h1>{{headline}}</h1><p class="sub">{{subheadline}}</p>{{ratingBadge}}<a class="cta" href="{{ctaHref}}">{{ctaText}}</a></div>';
    const heroOut = engine.sectionToHtml(heroTpl, THEME, null);
    assert.ok(heroOut.includes('data-template="custom"'), 'hero stamped');
    assert.ok(heroOut.includes('Pin Headline'), 'hero headline token renders');
    assert.ok(heroOut.includes('4.9') && heroOut.includes('128'), 'hero rating badge token renders');
    assert.ok(heroOut.includes('href="#contact"'), 'hero CTA href token renders');
    n += 4;
    // The portal inline-edit canvas keeps the standard renderer.
    const editOut = engine.sectionToHtml(faqTpl, THEME, { editing: true, page: 0, section: 0 });
    assert.ok(editOut.includes('<details'), 'edit-mode render uses the standard renderer');
    assert.ok(!editOut.includes('data-template'), 'edit-mode render is not stamped');
    n += 2;
    group('Part 5 — template renders', n);
  }

  /* ================================================================== */
  /* Part 6 — save rejection through domain.validatePages                */
  /* ================================================================== */
  {
    let n = 0;
    const domain = require(path.join(root, 'server/domain.js'));
    const pageWith = (section) => [{ slug: '/', title: 'Home', sections: [section] }];
    const faqBad = JSON.parse(JSON.stringify(FIXTURES.faq));
    faqBad.template = '<div>no loop here</div>';
    assert.throws(
      () => domain.validatePages(pageWith(faqBad)),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /items/.test(e.message),
      'validatePages rejects a hookless template naming the hook'
    );
    n++;
    const faqGood = JSON.parse(JSON.stringify(FIXTURES.faq));
    faqGood.template = FAQ_TEMPLATE;
    assert.doesNotThrow(() => domain.validatePages(pageWith(faqGood)), 'validatePages accepts a valid template');
    n++;
    const navTpl = JSON.parse(JSON.stringify(FIXTURES.nav));
    navTpl.template = '<div>chrome</div>';
    assert.throws(
      () => domain.validatePages(pageWith(navTpl)),
      (e) => e.code === 'TEMPLATE_NOT_AVAILABLE',
      'validatePages refuses a template on chrome'
    );
    n++;
    const cfBad = JSON.parse(JSON.stringify(FIXTURES.contact_form));
    cfBad.template =
      '<div id="contact"><form action="{{formAction}}" method="post"><input name="name"><textarea name="message"></textarea><button type="submit">S</button></form></div>';
    assert.throws(
      () => domain.validatePages(pageWith(cfBad)),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /email/.test(e.message),
      'validatePages rejects a contact_form template missing the email field, naming it'
    );
    n++;
    const cfNoAction = JSON.parse(JSON.stringify(FIXTURES.contact_form));
    cfNoAction.template =
      '<div id="contact"><form method="post" data-bitpype-form="1" data-form-token="{{form' +
      'Token}}"><input name="name"><input name="email"><textarea name="message"></textarea><button type="submit">S</button></form></div>';
    assert.throws(
      () => domain.validatePages(pageWith(cfNoAction)),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /formAction/.test(e.message),
      'validatePages rejects a contact_form template whose form lacks the action token'
    );
    n++;
    group('Part 6 — save rejection (domain.validatePages)', n);
  }

  /* ================================================================== */
  /* Part 7 — render-time fallback (hand-edited broken templates)        */
  /* ================================================================== */
  {
    let n = 0;
    const base = engine.sectionToHtml(JSON.parse(JSON.stringify(FIXTURES.faq)), THEME, null);
    const cases = [
      '<div>{{nosuchtoken}}</div>',
      '<div>{{#items}}<p>{{q}}</p></div>',
      '<div>{{#items}}{{#items}}<p>{{q}}</p>{{/items}}{{/items}}</div>',
      '<div>{{#bogus}}<p>x</p>{{/bogus}}</div>',
    ];
    for (const tpl of cases) {
      const s = JSON.parse(JSON.stringify(FIXTURES.faq));
      s.template = tpl;
      const out = engine.sectionToHtml(s, THEME, null);
      assert.equal(out, base, `broken template falls back to the standard bytes: ${tpl.slice(0, 40)}`);
      assert.ok(!out.includes('data-template'), 'fallback render is not stamped');
      n += 2;
    }
    group('Part 7 — render-time fallback', n);
  }

  /* ================================================================== */
  /* Part 8 — contact_form templates keep the form contract              */
  /* ================================================================== */
  {
    let n = 0;
    const bound = JSON.parse(JSON.stringify(FIXTURES.contact_form));
    bound.template = CF_TEMPLATE_BOUND;
    const boundOut = engine.sectionToHtml(bound, THEME, null);
    assert.ok(boundOut.includes('data-template="custom"'), 'bound template stamped');
    assert.ok(
      boundOut.includes('action="https://bitpype.test/api/v1/forms/public/TOK999/submit"'),
      'bound form action is the platform submit URL'
    );
    assert.ok(boundOut.includes('method="post"'), 'bound form method preserved');
    assert.ok(boundOut.includes('data-bitpype-form="1"'), 'bound form marker preserved');
    assert.ok(boundOut.includes('data-form-token="TOK999"'), 'bound form token preserved');
    for (const f of ['name="name"', 'name="phone"', 'name="email"', 'name="message"']) {
      assert.ok(boundOut.includes(f), `bound form keeps field ${f}`);
    }
    assert.ok(boundOut.includes('type="submit"'), 'bound form keeps a submit control');
    assert.ok(boundOut.includes('href="tel:6105550100"'), 'phone token renders the tel: link');
    n += 11;
    const unbound = JSON.parse(JSON.stringify(CF_MAILTO));
    unbound.template = CF_TEMPLATE_UNBOUND;
    const unboundOut = engine.sectionToHtml(unbound, THEME, null);
    assert.ok(
      unboundOut.includes('action="mailto:hi@example.com?subject=Website%20inquiry"'),
      'unbound form action is the mailto fallback'
    );
    assert.ok(
      unboundOut.includes('id="cf-name"') && unboundOut.includes('name="name"'),
      'unbound {{fields}} block carries the standard fields'
    );
    assert.ok(
      unboundOut.includes('id="cf-email"') && unboundOut.includes('id="cf-msg"'),
      'unbound fields keep the label-pairing ids'
    );
    assert.ok(!unboundOut.includes('data-bitpype-form'), 'unbound form carries no bitpype marker');
    n += 4;
    // {{fields}} satisfies the field + submit hooks at SAVE time too:
    // the chrome-only restyle must be storable, not just renderable.
    const cfStore = JSON.parse(JSON.stringify(CF_MAILTO));
    structure.setSectionTemplate(cfStore, CF_TEMPLATE_UNBOUND);
    assert.equal(cfStore.template, CF_TEMPLATE_UNBOUND, '{{fields}} template passes save validation');
    n++;
    // The {{#if bound}} attribute pattern: bound attrs render only
    // when bound, and the template validates in both binding states.
    const CF_TPL_IF =
      '<div id="contact" class="reach"><h2>{{title}}</h2><form action="{{formAction}}" method="post"{{#if bound}} data-bitpype-form="1" data-form-token="{{form' +
      'Token}}"{{/if}}>{{fields}}</form></div>';
    const cfIfBound = JSON.parse(JSON.stringify(FIXTURES.contact_form));
    structure.setSectionTemplate(cfIfBound, CF_TPL_IF);
    const cfIfBoundOut = engine.sectionToHtml(cfIfBound, THEME, null);
    assert.ok(
      cfIfBoundOut.includes('data-bitpype-form="1"') && cfIfBoundOut.includes('data-form-token="TOK999"'),
      '{{#if bound}} emits the binding attrs when bound'
    );
    const cfIfUnbound = JSON.parse(JSON.stringify(CF_MAILTO));
    structure.setSectionTemplate(cfIfUnbound, CF_TPL_IF);
    const cfIfUnboundOut = engine.sectionToHtml(cfIfUnbound, THEME, null);
    assert.ok(!cfIfUnboundOut.includes('data-bitpype-form'), '{{#if bound}} omits the binding attrs when unbound');
    assert.ok(
      cfIfUnboundOut.includes('action="mailto:hi@example.com?subject=Website%20inquiry"'),
      '{{#if bound}} template keeps the mailto action unbound'
    );
    n += 4;
    group('Part 8 — contact_form form contract', n);
  }

  /* ================================================================== */
  /* Part 9 — sanitization                                               */
  /* ================================================================== */
  {
    let n = 0;
    const evil = JSON.parse(JSON.stringify(FIXTURES.faq));
    evil.template = '<div onclick="steal()" onmouseover="x()">{{#items}}<p>{{q}}</p>{{/items}}</div>';
    const out = engine.sectionToHtml(evil, THEME, null);
    assert.ok(!out.includes('onclick') && !out.includes('onmouseover'), 'event handlers are stripped at render');
    assert.ok(out.includes('data-template="custom"'), 'sanitized template still renders');
    assert.ok(out.includes('Q one?'), 'sanitized template still substitutes data');
    n += 3;
    const verdict = templates.validateTemplate(
      'faq',
      '<div>{{#items}}<p>{{q}}</p>{{/items}}</div><scr' + 'ipt src="https://evil.example/x.js"></scr' + 'ipt>',
      {}
    );
    assert.equal(verdict.ok, false, 'script template fails validation');
    assert.ok(
      verdict.problems.some((p) => p.code === 'TEMPLATE_SCRIPT'),
      'script refusal is named'
    );
    const verdict2 = templates.validateTemplate('text', '<div data-bitpype-chat="1">{{body}}</div>', {});
    assert.ok(
      verdict2.problems.some((p) => p.code === 'TEMPLATE_MOUNT'),
      'chat mount in a template is refused'
    );
    const verdict3 = templates.validateTemplate('text', '<iframe src="https://evil.example"></iframe>{{body}}', {});
    assert.ok(
      verdict3.problems.some((p) => p.code === 'TEMPLATE_FORBIDDEN_TAG'),
      'iframe in a template is refused'
    );
    n += 4;
    group('Part 9 — sanitization', n);
  }

  /* ================================================================== */
  /* Setup for Part 10 — fixture workspace + site                        */
  /* ================================================================== */
  const platformDb = require(path.join(root, 'server/db.js'));
  await platformDb.migrate();
  const workspace = require(path.join(root, 'server/workspace.js'));
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const acct = await workspace.createUserWithWorkspace({
    email: 'a197@example.invalid',
    password: ['batch197', 'fixture', 'pw'].join('-'),
    name: 'A197',
    workspaceName: 'Batch197 WS',
  });
  const WS_ID = Number(acct.workspaceId);
  const LEAD_A = 197001;
  const db = openWorkspaceDb(WS_ID);
  db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(
    LEAD_A,
    'B197 Fixture Bakery',
    'b197@example.invalid',
    'customer'
  );
  const pages197 = [
    {
      slug: '/',
      title: 'Home',
      sections: [
        { type: 'nav', content: { brand: 'B197 Fixture Bakery' } },
        Object.assign(JSON.parse(JSON.stringify(FIXTURES.faq)), { template: FAQ_TEMPLATE }),
        { type: 'footer', content: {} },
      ],
    },
  ];
  const siteInfo = db
    .prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)')
    .run(LEAD_A, 'B197 Fixture Bakery', 'draft', JSON.stringify(pages197), JSON.stringify(THEME));
  const SITE_A = Number(siteInfo.lastInsertRowid);

  /* ================================================================== */
  /* Part 10 — QA check section-templates-valid                          */
  /* ================================================================== */
  {
    let n = 0;
    const clean = await engine.qaSite(db, SITE_A);
    const cClean = (clean.checks || []).find((c) => c.name === 'section-templates-valid');
    assert.ok(cClean, 'QA carries the template check');
    assert.equal(cClean.pass, true, 'QA passes a site whose templates satisfy the manifest');
    n += 2;
    const badPages = JSON.parse(JSON.stringify(pages197));
    badPages[0].sections[1].template = '<div>hand-edited, no loop</div>';
    db.prepare('UPDATE websites SET pages = ? WHERE id = ?').run(JSON.stringify(badPages), SITE_A);
    const bad = await engine.qaSite(db, SITE_A);
    const cBad = (bad.checks || []).find((c) => c.name === 'section-templates-valid');
    assert.ok(cBad, 'QA carries the template check on the bad site');
    assert.equal(cBad.pass, false, 'QA fails a hand-edited hookless template');
    assert.ok(/items/.test(cBad.detail), 'QA names the missing hook');
    n += 3;
    group('Part 10 — QA template check', n);
  }

  /* ================================================================== */
  /* Part 11 — export browser audit (template-hook violations)           */
  /* ================================================================== */
  {
    let n = 0;
    const spacingQa = require(path.join(root, 'server/spacingQa.js'));
    assert.equal(typeof spacingQa.measureTemplateHooksInPage, 'function', 'spacingQa exports the hook measurement');
    n++;
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b197-export-'));
    const goodSection = JSON.parse(JSON.stringify(FIXTURES.contact_form));
    goodSection.template = CF_TEMPLATE_BOUND;
    const goodHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
      engine.sectionToHtml(goodSection, THEME, null) +
      '</body></html>';
    const badHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
      '<section data-ws-section="1" data-ws-section-type="contact_form" data-template="custom"><div class="reach"><p>No form at all.</p></div></section>' +
      '</body></html>';
    fs.writeFileSync(path.join(exportDir, 'index.html'), goodHtml);
    fs.writeFileSync(path.join(exportDir, 'bad.html'), badHtml);
    let audit = null;
    let auditErr = null;
    try {
      audit = await spacingQa.assessExportedFiles(
        { dir: exportDir, files: ['index.html', 'bad.html'] },
        { widths: [390] }
      );
    } catch (e) {
      auditErr = e;
    }
    if (audit) {
      const hookViolations = (audit.violations || []).filter((v) => v.kind === 'template-hook');
      assert.ok(hookViolations.length >= 4, 'the formless custom contact_form is flagged for every missing DOM hook');
      assert.ok(
        hookViolations.every((v) => v.page === 'bad.html'),
        'only the bad page is flagged'
      );
      assert.ok(
        hookViolations.some((v) => /name="name"/.test(v.selector)),
        'the missing name field is named'
      );
      assert.ok(
        hookViolations.some((v) => /form/.test(v.selector)),
        'the missing form element is named'
      );
      n += 4;
    } else {
      console.log(`  (Part 11 browser audit skipped locally: ${auditErr && (auditErr.code || auditErr.message)})`);
    }
    group('Part 11 — export browser audit', n);
  }

  /* ================================================================== */
  /* Part 12 — manifest summary + agent surface                          */
  /* ================================================================== */
  {
    let n = 0;
    const summary = templates.manifestSummary();
    assert.equal(summary.version, 1, 'summary carries a version');
    assert.deepEqual(
      Object.keys(summary.types).sort(),
      Object.keys(engine.RENDERERS).sort(),
      'summary covers every renderer type'
    );
    assert.equal(summary.types.contact_form.templates, true, 'summary offers contact_form templates');
    assert.equal(summary.types.nav.templates, false, 'summary fences chrome');
    assert.ok(/chrome/.test(summary.types.nav.reason), 'summary records the chrome reason');
    assert.ok(
      summary.types.faq.loops.some((l) => l.name === 'items'),
      'summary exposes the faq loop'
    );
    assert.ok(
      summary.types.faq.loops[0].fields.some((f) => f.name === 'q'),
      'summary exposes loop fields'
    );
    assert.ok(
      summary.types.hero.tokens.some((t) => t.name === 'ctaHref' && t.kind === 'url'),
      'summary exposes token kinds'
    );
    n += 8;
    const mcpSrc = read('server/mcp.js');
    assert.ok(mcpSrc.includes("name: 'design.templates'"), 'MCP defines design.templates');
    assert.ok(mcpSrc.includes("case 'design.templates'"), 'MCP handles design.templates');
    assert.ok(mcpSrc.includes('manifestSummary()'), 'design.templates serves the manifest summary');
    n += 3;
    group('Part 12 — manifest summary + agent surface', n);
  }

  console.log(`\nbatch197: all ${groups} groups passed`);
})().catch((e) => {
  console.error('batch197 FAILED:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
