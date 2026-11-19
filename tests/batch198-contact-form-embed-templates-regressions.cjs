'use strict';
/**
 * Batch 198 — contact_form EMBED-MODE template hooks (a Batch 197
 * Part A correction, found by Ely's Victoria live test, 2026-11-19).
 *
 * The finding: production contact forms are EMBED-mode — the section
 * content carries bitpype_embed_html, the standard renderer
 * suppresses the static fields, and form-embed.js builds the working
 * form in the visitor's browser from the form schema (submitting
 * with Turnstile captcha — a native POST to the submit endpoint is
 * rejected CAPTCHA_REQUIRED, verified live). Batch 197's manifest
 * required the STATIC form hooks for every contact_form, so a custom
 * template on a real production contact form could only pass
 * validation by replacing the working embed with a static form that
 * cannot submit — the opposite of "functionality unchanged".
 *
 * The fix (src/sectionTemplates.js only): hooks may carry
 * `modes: ['static'|'embed']`, decided by sectionMode(content) —
 * 'embed' when content.bitpype_embed_html is non-empty (mirroring
 * cContactForm's suppressFields rule), else 'static'. In embed mode
 * the static-form hooks no longer apply; instead {{embedHtml}} is a
 * REQUIRED hook (dropping it drops the form itself). id="contact"
 * is required in both modes. Static/mailto behaviour is unchanged
 * (the Batch 197 suite must stay green untouched).
 *
 *   Part 1 — source pins + mode detection.
 *   Part 2 — validateTemplate matrix (embed/static × good/bad).
 *   Part 3 — save path: domain.validatePages accepts/rejects.
 *   Part 4 — renders: embed template stamps + carries the mount;
 *     broken hand-set template falls back to the default bytes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b198-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch198', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 31).toString('base64');

const THEME = { primary: '#1d4633', secondary: '#0e2c1f', bg: '#ede4cb', text: '#22301f' };

const EMBED_HTML =
  '<div class="bitpype-form-embed" data-bitpype-managed="1" data-bitpype-form-embed="1_TESTTOKEN" data-bitpype-api="https://bitpype.test"></div>\n' +
  '<script src="https://bitpype.test/js/form-embed.js?v=form9" defer data-bitpype-form-script="1"></script>';

/* Victoria-shaped embed-mode content (bound + embed, fields suppressed). */
const CF_EMBED = {
  type: 'contact_form',
  content: {
    title: 'Send us a message',
    text: 'Write to us.',
    form_action: 'https://bitpype.test/api/v1/forms/public/1_TESTTOKEN/submit',
    form_token: '1_TESTTOKEN',
    form_method: 'post',
    embed_mode: 'js',
    suppress_fields: true,
    bitpype_embed_html: EMBED_HTML,
  },
};
/* Batch 197-shaped static bound content (no embed). */
const CF_STATIC = {
  type: 'contact_form',
  content: {
    title: 'Contact',
    text: 'Reach out',
    form_action: 'https://bitpype.test/api/v1/forms/public/TOK999/submit',
    form_token: 'TOK999',
    phone: '610-555-0100',
    email: 'hi@example.com',
  },
};
const CF_MAILTO = { type: 'contact_form', content: { title: 'Email us', email: 'hi@example.com' } };

const EMBED_TEMPLATE =
  '<div id="contact" class="b198-embed-wrap"><h2>{{title}}</h2><p>{{text}}</p><div class="b198-mount">{{embedHtml}}</div></div>';
const STATIC_TEMPLATE =
  '<div id="contact" class="b198-static"><h2>{{title}}</h2>' +
  '<form action="{{formAction}}" method="post"{{#if bound}} data-bitpype-form="1" data-form-token="{{form' +
  'Token}}"{{/if}}>{{fields}}</form></div>';

let groups = 0;
function group(name, n) {
  groups++;
  console.log(`ok ${groups} - ${name} (${n} checks)`);
}

(async () => {
  const templates = require(path.join(root, 'src/sectionTemplates.js'));
  const engine = require(path.join(root, 'src/websiteEngine.js'));
  const domain = require(path.join(root, 'server/domain.js'));

  /* ============ Part 1 — source pins + mode detection ============ */
  {
    let n = 0;
    const src = read('src/sectionTemplates.js');
    assert.ok(/modes: \['embed'\]/.test(src), 'an embed-mode hook exists in the manifest source');
    n++;
    assert.ok(/EMBED MODE \(Batch 198\)/.test(src), 'manifest summary documents embed mode');
    n++;
    assert.equal(templates.sectionMode(CF_EMBED.content), 'embed', 'embed html content is embed mode');
    n++;
    assert.equal(templates.sectionMode(CF_STATIC.content), 'static', 'bound-only content is static mode');
    n++;
    assert.equal(templates.sectionMode(CF_MAILTO.content), 'static', 'mailto content is static mode');
    n++;
    assert.equal(templates.sectionMode({}), 'static', 'empty content is static mode');
    n++;
    const cf = templates.getEntry('contact_form');
    const embedHook = cf.hooks.find((h) => h.token === 'embedHtml');
    assert.ok(
      embedHook && embedHook.required && embedHook.modes.includes('embed'),
      'embedHtml hook is required in embed mode'
    );
    n++;
    const fieldHook = cf.hooks.find((h) => h.kind === 'field' && h.name === 'email');
    assert.ok(fieldHook.modes.includes('static') && !fieldHook.modes.includes('embed'), 'field hooks are static-only');
    n++;
    group('Part 1 — source pins + mode detection', n);
  }

  /* ============ Part 2 — validateTemplate matrix ============ */
  {
    let n = 0;
    const okEmbed = templates.validateTemplate('contact_form', EMBED_TEMPLATE, CF_EMBED.content);
    assert.equal(okEmbed.ok, true, `embed template validates on embed content (${JSON.stringify(okEmbed.problems)})`);
    n++;
    const staticOnEmbed = templates.validateTemplate('contact_form', STATIC_TEMPLATE, CF_EMBED.content);
    assert.equal(staticOnEmbed.ok, false, 'static-only template refused on embed content');
    n++;
    assert.ok(
      staticOnEmbed.problems.some((p) => p.code === 'TEMPLATE_MISSING_HOOK' && /embedHtml/.test(p.message)),
      'refusal names the {{embedHtml}} hook'
    );
    n++;
    const hookless = templates.validateTemplate('contact_form', '<div id="contact">nothing</div>', CF_EMBED.content);
    assert.equal(hookless.ok, false, 'hookless template refused on embed content');
    n++;
    const okStatic = templates.validateTemplate('contact_form', STATIC_TEMPLATE, CF_STATIC.content);
    assert.equal(okStatic.ok, true, 'static template still validates on static bound content (197 behaviour)');
    n++;
    const embedOnStatic = templates.validateTemplate('contact_form', EMBED_TEMPLATE, CF_STATIC.content);
    assert.equal(embedOnStatic.ok, false, 'embed-only template refused on static content');
    n++;
    assert.ok(
      embedOnStatic.problems.some((p) => p.code === 'TEMPLATE_MISSING_HOOK'),
      'static refusal names a missing hook'
    );
    n++;
    const okMailto = templates.validateTemplate('contact_form', STATIC_TEMPLATE, CF_MAILTO.content);
    assert.equal(okMailto.ok, true, 'static template validates on mailto content');
    n++;
    group('Part 2 — validateTemplate matrix', n);
  }

  /* ============ Part 3 — save path (domain.validatePages) ============ */
  {
    let n = 0;
    const pageWith = (section) => [
      { slug: '/', title: 'Home', sections: [{ type: 'nav', content: {} }, section, { type: 'footer', content: {} }] },
    ];
    const good = JSON.parse(JSON.stringify(CF_EMBED));
    good.template = EMBED_TEMPLATE;
    assert.doesNotThrow(() => domain.validatePages(pageWith(good)), 'validatePages accepts the embed template');
    n++;
    const bad = JSON.parse(JSON.stringify(CF_EMBED));
    bad.template = STATIC_TEMPLATE;
    assert.throws(
      () => domain.validatePages(pageWith(bad)),
      (e) => e.code === 'TEMPLATE_MISSING_HOOK' && /embedHtml/.test(e.message),
      'validatePages rejects a static-only template on embed content, naming {{embedHtml}}'
    );
    n++;
    group('Part 3 — save path (domain.validatePages)', n);
  }

  /* ============ Part 4 — renders + fallback ============ */
  {
    let n = 0;
    const templated = JSON.parse(JSON.stringify(CF_EMBED));
    templated.template = EMBED_TEMPLATE;
    const html = engine.sectionToHtml(templated, THEME, null);
    assert.ok(html.includes('data-template="custom"'), 'embed template render is stamped');
    n++;
    assert.ok(html.includes('b198-embed-wrap'), 'custom layout class renders');
    n++;
    assert.ok(html.includes('bitpype-form-embed'), 'the embed mount survives the template render');
    n++;
    assert.ok(html.includes('data-bitpype-form-embed="1_TESTTOKEN"'), 'the embed token survives');
    n++;
    const base = engine.sectionToHtml(JSON.parse(JSON.stringify(CF_EMBED)), THEME, null);
    const broken = JSON.parse(JSON.stringify(CF_EMBED));
    broken.template = '<div id="contact">{{noSuchToken}}</div>';
    const fellBack = engine.sectionToHtml(broken, THEME, null);
    assert.equal(fellBack, base, 'a broken hand-set template falls back to the default embed render, byte-identical');
    n++;
    assert.ok(!fellBack.includes('data-template="custom"'), 'fallback render carries no stamp');
    n++;
    group('Part 4 — renders + fallback', n);
  }

  console.log(`\nbatch198: all ${groups} groups passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
