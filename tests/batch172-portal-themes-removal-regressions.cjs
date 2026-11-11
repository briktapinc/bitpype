'use strict';
/**
 * Batch 172 — Themes section + wizard REMOVED from the client portal.
 *
 * Ely (2026-11-09): "Remove it from portal." Themes becomes a
 * staff-only tool (Batch 171 puts it in the staff Assistant page
 * and the new Design Job page). Batch 169 had put the section in
 * the client portal; this batch takes that portal surface back out:
 *
 *   - public/portal.html  — Themes block markup + wizard popup + CSS gone
 *   - public/js/portal.js — catalog/wizard code gone
 *   - server/routes/portal.js — the three /assistant/themes* routes
 *     gone (HTTP 404 behavior is covered by the adapted batch169
 *     suite, Part 3; this suite pins the source level)
 *
 * KEPT, and pinned present here: server/themesRegistry.js (shared
 * core the staff routes use) and public/themes/*.png (staff app
 * serves the same static thumbnails).
 *
 * The adapted batch169 suite keeps the shared-core coverage
 * (registry validity, buildWithTheme) — this suite is the removal's
 * own negative pin set so the portal surface cannot creep back.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_URL = 'https://example.invalid';
process.env.CAPTCHA_OPTIONAL = '1';

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const results = [];
function group(name, count) {
  results.push(`${name}: ${count} checks`);
  console.log(`  ok ${name} (${count})`);
}

function main() {
  /* Portal HTML: no trace of the 169 Themes section or wizard. */
  {
    let n = 0;
    const html = read('public/portal.html');
    for (const gone of [
      'id="themes-block"',
      'id="themes-catalog"',
      'id="themes-status"',
      'id="theme-wizard-backdrop"',
      'id="theme-wizard-form"',
      'id="tw-lead-select"',
      'id="tw-new-name"',
      'id="tw-build"',
      '.themes-block',
      '.themes-row',
      '.themes-category',
      '.theme-card',
      '.theme-wizard',
      'Start from a theme',
    ]) {
      assert.ok(!html.includes(gone), `portal.html no longer contains ${gone}`);
      n++;
    }
    // The assistant section itself is untouched: chat-only again.
    assert.ok(html.includes('id="sec-assistant"'), 'assistant section still present');
    assert.ok(html.includes('.assistant-layout'), 'assistant chat layout intact');
    n += 2;
    group('portal.html — themes surface absent, chat intact', n);
  }

  /* Portal JS: no catalog fetch, no wizard code. */
  {
    let n = 0;
    const js = read('public/js/portal.js');
    for (const gone of ['// Batch 169', '/assistant/themes', 'themes-block', 'theme-wizard', 'themes-catalog', 'Build this']) {
      assert.ok(!js.includes(gone), `portal.js no longer contains ${gone}`);
      n++;
    }
    assert.ok(js.includes('loadAssistant'), 'assistant loader intact');
    assert.ok(js.includes("api('/assistant/conversations')"), 'assistant chat calls intact');
    n += 2;
    group('portal.js — themes code absent, chat intact', n);
  }

  /* Portal router: the three routes are not registered. */
  {
    let n = 0;
    const routes = read('server/routes/portal.js');
    assert.ok(!routes.includes("'/assistant/themes'"), 'catalog route not registered');
    assert.ok(!routes.includes("'/assistant/themes/leads'"), 'lead search route not registered');
    assert.ok(!routes.includes("'/assistant/themes/build'"), 'build route not registered');
    assert.ok(!routes.includes('themesRegistry'), 'portal router has no registry accessor');
    n += 4;
    group('routes/portal.js — themes routes absent', n);
  }

  /* Shared core + assets KEPT for the staff app. */
  {
    let n = 0;
    const registryPath = path.join(root, 'server/themesRegistry.js');
    assert.ok(fs.existsSync(registryPath), 'server/themesRegistry.js kept');
    const registry = require(registryPath);
    assert.deepEqual(registry.validateThemes(), [], 'shared registry still validates clean');
    // Batch 175 pin update: registry now holds 28 (8 launch + 20 promoted).
    // Batch 179 pin update: registry now holds 94 (86 promoted in total).
    assert.equal(registry.THEMES.length, 94, 'registry still holds the launch themes (94 total after Batch 179)');
    n += 3;
    for (const slug of ['directory', 'store', 'services', 'restaurant', 'art', 'courses', 'events', 'blog']) {
      const file = path.join(root, 'public/themes', `${slug}.png`);
      assert.ok(fs.existsSync(file) && fs.statSync(file).size > 10000, `thumbnail kept at public/themes/${slug}.png`);
      n++;
    }
    group('shared core + thumbnails kept', n);
  }

  console.log(`\nbatch172 portal themes removal: ALL PASS\n${results.map((r) => '  - ' + r).join('\n')}`);
}

main();
