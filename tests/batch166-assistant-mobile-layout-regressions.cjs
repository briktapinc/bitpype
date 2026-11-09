'use strict';
/**
 * Batch 166 — Assistant page mobile layout fix (staff + portal).
 *
 * Ely's phone screenshots 2026-11-08 ~19:52 EST, minutes after
 * Batch 161 deployed: on the STAFF Assistant page at ~390px the
 * chat thread was crushed into a ~70-95px vertical sliver at the
 * right of the card, a sent bubble sat in that sliver, the
 * composer textarea rendered as a one-character-wide vertical
 * strip ("M/e/s/s/a…" stacked), Attach / Camera / Send spilled
 * off the card's right edge and the whole page panned sideways.
 *
 * DIAGNOSIS (file:line evidence on the Batch 161 tip 67dd3816):
 *  - public/js/app.js pageAssistant() declared EVERY layout rule
 *    as an inline style, so no @media query could ever reach it.
 *    The chat row was <div class="row" style="align-items:
 *    flex-start; gap:16px">: .row (styles.css) does carry
 *    flex-wrap:wrap, but the wrap can never engage — the
 *    conversation list had inline flex:0 0 230px and the main
 *    column inline flex:1 (basis 0%), and a 0% basis always
 *    "fits", so the main column simply absorbed what was left:
 *    390px viewport - shell/card padding (~72px) - 230px sidebar
 *    - 16px gap = ~72px for the thread. That IS the sliver.
 *  - The composer <form id="asst-form"> was inline display:flex
 *    with NO flex-wrap: Attach + Camera + Send (~206px of buttons
 *    + 24px gaps) inside a ~72px column left the flex:1 textarea
 *    ~1ch wide and pushed the buttons past the card edge; staff
 *    body has no overflow-x guard, so the page scrolled sideways.
 *  - The PORTAL page (portal.html .assistant-*) already stacked
 *    its layout at <=700px (Batch 161), but its composer was the
 *    same nowrap 4-item row: at 390px the buttons left the
 *    textarea a ~100px slot. Same defect family, milder dose.
 *  - The two surfaces do NOT share page code (portal = classes in
 *    portal.html; staff = inline styles in app.js) — each needed
 *    its own fix; this suite pins both.
 *
 * FIX: staff layout rules moved verbatim into .asst-* classes in
 * public/styles.css (same desktop geometry: 230px list, 60vh main)
 * with a <=700px block that stacks the page into one full-width
 * column and wraps the composer (textarea on its own full-width
 * row first via order:-1, buttons below, min-height 48px). Portal
 * gains the same composer wrap inside its existing <=700px block.
 * Desktop/tablet rendering is untouched: every new mobile rule
 * lives inside @media (max-width: 700px). styles.css cache-bust
 * bumped to batch166-asst1 (the batch113/115 pins rotated to
 * match, per the standing bumper-rotates-the-pins pattern).
 *
 * Part 1 — staff markup: class hooks in, inline layout styles out,
 *   ids/behaviour surface unchanged.
 * Part 2 — staff CSS: desktop geometry preserved + the <=700px
 *   stacking/wrapping facts + no fixed px widths on the chat-row
 *   children at mobile.
 * Part 3 — portal CSS: stacking intact + composer wrap added in
 *   the same <=700px block; desktop composer rule untouched.
 * Part 4 — no pill tab bar exists on either Assistant surface
 *   (Batch 113's mobile-dropdown standard is N/A here — pinned so
 *   a future tab bar on this page trips this suite and gets the
 *   treatment deliberately).
 * Part 5 — SEC-13 census: summary + (file|kind|snippet) multiset
 *   sha byte-identical to the Batch 161 tree (the template edit
 *   changed no sink: classification and the 160-char snippet,
 *   which covers only the untouched lede, are unchanged).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

/** Body of the FIRST rule for `selector` in `css` (naive brace match). */
function ruleBody(css, selector, fromIdx = 0) {
  const i = css.indexOf(selector, fromIdx);
  assert.ok(i >= 0, `selector present: ${selector}`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  throw new Error(`unbalanced rule for ${selector}`);
}

/** All @media (max-width: 700px) blocks in `css`, concatenated. */
function mobileCss(css) {
  const out = [];
  let idx = 0;
  for (;;) {
    const i = css.indexOf('@media (max-width: 700px)', idx);
    if (i < 0) break;
    const open = css.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') {
        depth--;
        if (depth === 0) {
          out.push(css.slice(open + 1, j));
          idx = j + 1;
          break;
        }
      }
    }
  }
  return out.join('\n');
}

(async () => {
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — staff markup (app.js pageAssistant template)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const start = appJs.indexOf('async function pageAssistant()');
    assert.ok(start > 0, 'pageAssistant present');
    n += 1;
    const tpl = appJs.slice(start, appJs.indexOf('`;', start));

    for (const hook of [
      'class="asst-layout"',
      'class="asst-convs" id="asst-convs"',
      'class="asst-main"',
      'class="asst-messages" id="asst-messages"',
      'class="asst-pending" id="asst-pending"',
      'class="asst-form" id="asst-form"',
    ]) {
      assert.ok(tpl.includes(hook), `template hook: ${hook}`);
      n += 1;
    }
    // No inline layout styles remain on the six layout elements.
    for (const id of ['asst-convs', 'asst-messages', 'asst-pending', 'asst-form', 'asst-input']) {
      const at = tpl.indexOf(`id="${id}"`);
      assert.ok(at > 0, `${id} still in template`);
      const tag = tpl.slice(tpl.lastIndexOf('<', at), tpl.indexOf('>', at) + 1);
      assert.ok(!tag.includes('style='), `${id} carries no inline style (tag: ${tag})`);
      n += 1;
    }
    assert.ok(!tpl.includes('flex:0 0 230px'), 'fixed 230px inline basis gone from the template');
    n += 1;
    // Behaviour surface unchanged: same ids, same composer controls.
    for (const id of ['asst-lead', 'asst-new', 'asst-attach', 'asst-camera', 'asst-input', 'asst-send', 'asst-file', 'asst-camera-file', 'asst-status', 'asst-usage']) {
      assert.ok(tpl.includes(`id="${id}"`), `id preserved: ${id}`);
      n += 1;
    }
    assert.ok(tpl.includes('<textarea id="asst-input" rows="2"'), 'composer textarea keeps rows=2');
    n += 1;
    group('Part 1 staff markup — class hooks, inline layout styles out', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — staff CSS (styles.css .asst-*)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const desk = (sel) => ruleBody(stylesCss, sel);
    const lay = desk('.asst-layout');
    assert.match(lay, /display:\s*flex/, '.asst-layout is a flex row on desktop');
    assert.match(lay, /gap:\s*16px/, '.asst-layout keeps the 16px gap');
    assert.match(lay, /align-items:\s*flex-start/, '.asst-layout keeps flex-start alignment');
    n += 3;
    const convs = desk('.asst-convs');
    assert.match(convs, /flex:\s*0 0 230px/, 'desktop conversation list keeps its 230px basis');
    assert.match(convs, /max-height:\s*60vh/, 'desktop conversation list keeps 60vh cap');
    n += 2;
    const main = desk('.asst-main');
    assert.match(main, /flex:\s*1/, '.asst-main grows on desktop');
    assert.match(main, /min-width:\s*0/, '.asst-main keeps min-width:0');
    assert.match(main, /height:\s*60vh/, '.asst-main keeps the 60vh height');
    n += 3;
    const msgs = desk('.asst-messages');
    assert.match(msgs, /overflow-y:\s*auto/, 'thread scrolls internally on desktop');
    assert.match(msgs, /border-radius:\s*12px/, 'thread keeps its card radius');
    n += 2;
    const form = desk('.asst-form');
    assert.match(form, /display:\s*flex/, '.asst-form is a flex row on desktop');
    assert.ok(!/flex-wrap:\s*wrap/.test(form), 'desktop composer does NOT wrap (layout unchanged above 700px)');
    n += 2;
    const ta = desk('.asst-form textarea');
    assert.match(ta, /flex:\s*1/, 'desktop textarea grows');
    assert.match(ta, /min-width:\s*0/, 'desktop textarea can shrink instead of overflowing');
    assert.match(ta, /min-height:\s*44px/, 'desktop textarea keeps a >=44px touch height');
    n += 3;

    const mob = mobileCss(stylesCss);
    assert.match(ruleBody(mob, '.asst-layout'), /flex-direction:\s*column/, 'mobile: layout stacks to one column');
    n += 1;
    const mConvs = ruleBody(mob, '.asst-convs');
    assert.match(mConvs, /flex:\s*none/, 'mobile: conversation list basis released');
    assert.match(mConvs, /width:\s*100%/, 'mobile: conversation list is full width');
    assert.ok(!/230px/.test(mConvs), 'mobile: no fixed 230px width on the conversation list');
    n += 3;
    assert.match(ruleBody(mob, '.asst-main'), /width:\s*100%/, 'mobile: main column is full width');
    n += 1;
    assert.match(ruleBody(mob, '.asst-form'), /flex-wrap:\s*wrap/, 'mobile: composer wraps');
    n += 1;
    const mTa = ruleBody(mob, '.asst-form textarea');
    assert.match(mTa, /order:\s*-1/, 'mobile: textarea takes the first (full-width) row');
    assert.match(mTa, /flex:\s*1 1 100%/, 'mobile: textarea spans the full composer width');
    assert.match(mTa, /min-height:\s*48px/, 'mobile: textarea is at least 48px tall');
    n += 3;
    // No fixed pixel width on ANY .asst-* rule inside the mobile blocks.
    const pxWidths = [...mob.matchAll(/\.asst-[a-z]+\s*(?:textarea)?\s*\{[^}]*?width:\s*(\d+)px/g)].map((m) => m[1]);
    assert.deepEqual(pxWidths, [], `mobile .asst-* rules carry no fixed px widths (got ${pxWidths})`);
    n += 1;

    assert.ok(indexHtml.includes('/styles.css?v=batch166-asst1'), 'styles.css cache-bust bumped for the fix');
    n += 1;
    group('Part 2 staff CSS — desktop geometry kept, <=700px stacks + wraps', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — portal CSS (portal.html .assistant-*)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const mob = mobileCss(portalHtml);
    assert.match(ruleBody(mob, '.assistant-layout'), /flex-direction:\s*column/, 'portal mobile: layout still stacks');
    assert.match(ruleBody(mob, '.assistant-main'), /height:\s*58vh/, 'portal mobile: main height unchanged');
    n += 2;
    assert.match(ruleBody(mob, '.assistant-composer'), /flex-wrap:\s*wrap/, 'portal mobile: composer wraps');
    n += 1;
    const mTa = ruleBody(mob, '.assistant-composer textarea');
    assert.match(mTa, /order:\s*-1/, 'portal mobile: textarea takes the first (full-width) row');
    assert.match(mTa, /flex:\s*1 1 100%/, 'portal mobile: textarea spans the full composer width');
    assert.match(mTa, /min-height:\s*48px/, 'portal mobile: textarea is at least 48px tall');
    n += 3;
    const deskComposer = ruleBody(portalHtml, '.assistant-composer');
    assert.match(deskComposer, /display:\s*flex/, 'portal desktop composer still a flex row');
    assert.ok(!/flex-wrap/.test(deskComposer), 'portal desktop composer unchanged (no wrap above 700px)');
    n += 2;
    assert.match(ruleBody(portalHtml, '.assistant-convs'), /flex:\s*0 0 240px/, 'portal desktop conversation list basis unchanged');
    n += 1;
    group('Part 3 portal CSS — composer wrap added, desktop untouched', n);
  }

  // ---------------------------------------------------------------
  // Part 4 — pill-tab standard: N/A on this page, pinned
  // ---------------------------------------------------------------
  {
    let n = 0;
    const start = appJs.indexOf('async function pageAssistant()');
    const tpl = appJs.slice(start, appJs.indexOf('`;', start));
    assert.ok(!tpl.includes('class="tabs'), 'staff Assistant page has no pill tab bar (mobile-dropdown standard N/A)');
    n += 1;
    const secStart = portalHtml.indexOf('id="sec-assistant"');
    const sec = portalHtml.slice(secStart, portalHtml.indexOf('<section', secStart + 10));
    assert.ok(!sec.includes('class="tabs'), 'portal Assistant panel has no pill tab bar (mobile-dropdown standard N/A)');
    n += 1;
    group('Part 4 pill-tab check — none on either Assistant surface', n);
  }

  // ---------------------------------------------------------------
  // Part 5 — SEC-13 census unchanged
  // ---------------------------------------------------------------
  {
    let n = 0;
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 504, STATIC: 187, ESCAPED: 48, SAFE: 81, BUILDER: 64, IDENT: 38, RAW: 86 },
      'SEC-13 census summary identical to the deployed Batch 165 tree (166 contributes zero sink movement — pairwise (file|kind|snippet) multiset diff vs the pristine 165 tree is empty)'
    );
    n += 1;
    const multi = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multi.join('\n')).digest('hex');
    assert.equal(sha, '20da195b82955ec635ce1dff9f57ff4d3773270087ab97194c39630390c061e8', 'SEC-13 (file|kind|snippet) multiset byte-identical to the deployed Batch 165 tree');
    n += 1;
    group('Part 5 SEC-13 census — unchanged, no rotation', n);
  }

  console.log(`BATCH166 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH166 REGRESSION FAIL', e);
  process.exit(1);
});
