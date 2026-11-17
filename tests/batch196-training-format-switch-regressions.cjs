'use strict';
/**
 * Batch 196 — Portal Training player: 16:9 / mobile format switch.
 *
 * Batch 194 picked the Training video file by viewport (mobile file
 * under 700px, 16:9 above) with no viewer override. Batch 196 adds a
 * two-option switch ("16:9" / "Mobile") under each module player —
 * shown ONLY when the module has both files — that swaps the player
 * source for that viewing, carrying the playback position and play
 * state across the swap. The default selection is byte-identical to
 * the Batch 194 rule.
 *
 * Proven here:
 *  1. Source contract: the both-files condition, the unchanged
 *     default rule + 700px breakpoint, the switch markup (fmtBtn,
 *     data-training-fmt, aria-pressed), and the swap wiring
 *     (loadedmetadata restore, clamped seek, play-state resume).
 *     SEC-13 census: totals + per-kind counts unchanged (518) and
 *     the RAW/IDENT baseline set equals the live census set exactly
 *     (27 portal.js positions shifted by the insertion, whole-tree
 *     (file,kind,snippet) multiset identical to the Batch 195 tree).
 *  2. Browser (stub API + real portal.html/portal.js + the real
 *     shipped MP4s, the site-analytics-portal-browser harness):
 *     wide viewport -> main file default, 16:9 pressed; narrow
 *     viewport -> mobile file default, Mobile pressed; toggling
 *     changes the served source to the other format's file and
 *     back; a paused swap restores the position within 1s; a
 *     playing swap resumes playback near the pre-swap position;
 *     single-file modules render no switch and play as before
 *     (main-only plays its file at both widths; mobile-only shows
 *     the Batch 194 "Video coming soon." at wide width and plays
 *     its file at narrow width); no page errors.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

(async () => {
  const portalSrc = fs.readFileSync(path.join(root, 'public', 'js', 'portal.js'), 'utf8');

  // ---------------------------------------------------------------
  // Part 1 — source contract + SEC-13 census pin
  // ---------------------------------------------------------------
  {
    let n = 0;
    const at = portalSrc.indexOf('async function loadTraining()');
    assert.ok(at > 0, 'loadTraining present');
    n += 1;
    const block = portalSrc.slice(at, portalSrc.indexOf('async function loadPackages()', at));
    assert.ok(block.includes('const both = !!(m.videoUrl && m.videoMobileUrl);'), 'switch gated on BOTH files present');
    n += 1;
    assert.ok(
      block.includes('const useMobile = narrow && !!m.videoMobileUrl;'),
      'default rule preserved (narrow + mobile file)'
    );
    n += 1;
    assert.ok(
      block.includes('const src = useMobile ? m.videoMobileUrl : m.videoUrl;'),
      'default src selection preserved'
    );
    n += 1;
    assert.ok(block.includes('window.innerWidth < 700'), '700px viewport breakpoint unchanged');
    n += 1;
    assert.ok(
      block.includes("fmtBtn('main', '16:9')") && block.includes("fmtBtn('mobile', 'Mobile')"),
      'switch offers 16:9 + Mobile'
    );
    n += 1;
    assert.ok(
      block.includes('data-training-fmt="${fmt}"') && block.includes('aria-pressed'),
      'switch buttons carry fmt + pressed state'
    );
    n += 1;
    assert.ok(
      block.includes("data-training-current=\"${useMobile ? 'mobile' : 'main'}\""),
      'player stamps its starting format'
    );
    n += 1;
    assert.ok(
      block.includes("video.addEventListener('loadedmetadata', restore, { once: true });"),
      'swap restores on loadedmetadata'
    );
    n += 1;
    assert.ok(
      block.includes('video.currentTime = Math.min(at, video.duration);'),
      'restore seek clamps to the new duration'
    );
    n += 1;
    assert.ok(block.includes('if (wasPlaying) video.play().catch(() => {});'), 'swap resumes play state');
    n += 1;
    assert.ok(
      block.includes('video.src = target;') && block.includes('video.load();'),
      'swap assigns the other file and reloads'
    );
    n += 1;

    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 518, STATIC: 193, ESCAPED: 49, SAFE: 81, BUILDER: 64, IDENT: 43, RAW: 88 },
      'SEC-13 census summary unchanged by Batch 196'
    );
    n += 1;
    const reviewed = new Set(
      cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`)
    );
    const BASELINE = new Set(require(path.join(root, 'tests', 'batch103-xss-baseline.json')));
    assert.deepEqual(
      [...reviewed].filter((x) => !BASELINE.has(x)),
      [],
      'no new/moved RAW/IDENT sinks vs baseline'
    );
    n += 1;
    assert.deepEqual(
      [...BASELINE].filter((x) => !reviewed.has(x)),
      [],
      'no stale baseline entries'
    );
    n += 1;
    group('Part 1 source contract + census', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — real portal session in Chromium (stub API)
  // ---------------------------------------------------------------
  {
    let n = 0;
    const puppeteer = require('puppeteer');
    const http = require('node:http');
    const express = require('express');

    const ALL_TABS = [
      'website',
      'changes',
      'forms',
      'leadscout',
      'modules',
      'social',
      'referrals',
      'mcp',
      'soul',
      'assistant',
      'analytics',
      'seo',
      'gbp',
      'rentals',
      'billing',
      'wordpress',
      'training',
      'packages',
    ];
    const MODULES = [
      {
        id: 1,
        title: 'Both Files Module',
        videoUrl: '/training/02-signing-in.mp4',
        videoMobileUrl: '/training-mobile/02-signing-in.mp4',
        transcript: 'Both files transcript.',
      },
      {
        id: 2,
        title: 'Main Only Module',
        videoUrl: '/training/03-finding-your-way-around.mp4',
        videoMobileUrl: '',
        transcript: 'Main only transcript.',
      },
      {
        id: 3,
        title: 'Mobile Only Module',
        videoUrl: '',
        videoMobileUrl: '/training-mobile/03-finding-your-way-around.mp4',
        transcript: 'Mobile only transcript.',
      },
    ];

    const app = express();
    app.use(express.json());
    app.get('/api/v1/captcha/config', (_q, r) => r.json({ ok: true, data: { enabled: false } }));
    app.get('/api/v1/portal/me', (_q, r) =>
      r.json({
        ok: true,
        data: {
          client: { id: 1, email: 'owner@b196.fixture', businessName: 'ZZ B196 Bakery', visibleTabs: ALL_TABS },
          lead: { business_name: 'ZZ B196 Bakery', city: 'Blandon', state: 'PA' },
          site: { id: 1, name: 'ZZ B196 Bakery' },
          previewUrl: null,
        },
      })
    );
    app.get('/api/v1/portal/training', (_q, r) => r.json({ ok: true, data: { modules: MODULES } }));
    app.use('/api/v1/portal', (_q, r) =>
      r.json({
        ok: true,
        data: { plan: 'standard', plans: [], forms: [], modules: [], contacts: [], accounts: [], previewUrl: null },
      })
    );
    app.get('/portal', (_q, r) => r.sendFile(path.join(root, 'public', 'portal.html')));
    app.use(express.static(path.join(root, 'public'), { index: false }));

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith(base) ? r.continue() : r.abort()));

      const panels = () => page.$$('#training-host > .panel');
      const videoOf = async (idx) => {
        const ps = await panels();
        return ps[idx].$('video[data-training-video]');
      };
      const srcOf = async (idx) => {
        const v = await videoOf(idx);
        return v ? v.evaluate((el) => el.getAttribute('src')) : null;
      };
      const fmtBtns = async (idx) => {
        const ps = await panels();
        return ps[idx].$$('.training-fmt-btn');
      };
      const pressed = async (idx) => {
        const btns = await fmtBtns(idx);
        const out = {};
        for (const b of btns) {
          out[await b.evaluate((el) => el.getAttribute('data-training-fmt'))] = await b.evaluate((el) =>
            el.getAttribute('aria-pressed')
          );
        }
        return out;
      };
      const clickFmt = async (idx, fmt) => {
        const btns = await fmtBtns(idx);
        for (const b of btns) {
          if ((await b.evaluate((el) => el.getAttribute('data-training-fmt'))) === fmt) {
            await b.evaluate((el) => el.click());
            return true;
          }
        }
        return false;
      };
      const waitCurrent = (idx, fmt) =>
        page.waitForFunction(
          (i, f) => {
            const v = document
              .querySelectorAll('#training-host > .panel')
              [i]?.querySelector('video[data-training-video]');
            return v && v.getAttribute('data-training-current') === f && v.readyState >= 1;
          },
          { timeout: 20000, polling: 100 },
          idx,
          fmt
        );

      // — Wide viewport (1280): Batch 194 default = main file —
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(base + '/portal#/training');
      await page.waitForSelector('#sec-training:not([hidden])', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('#training-host > .panel').length === 3, {
        timeout: 15000,
        polling: 100,
      });
      assert.equal(await srcOf(0), '/training/02-signing-in.mp4', 'wide: both-files module defaults to the 16:9 file');
      n += 1;
      assert.deepEqual(await pressed(0), { main: 'true', mobile: 'false' }, 'wide: 16:9 pressed, Mobile not');
      n += 1;
      assert.equal((await fmtBtns(1)).length, 0, 'main-only module renders NO switch');
      n += 1;
      assert.equal(
        await srcOf(1),
        '/training/03-finding-your-way-around.mp4',
        'main-only module plays its file (wide)'
      );
      n += 1;
      assert.equal((await fmtBtns(2)).length, 0, 'mobile-only module renders NO switch');
      n += 1;
      assert.equal(await videoOf(2), null, 'mobile-only module has no player at wide width (Batch 194 behaviour)');
      n += 1;
      const panel3Text = await (await panels())[2].evaluate((el) => el.textContent);
      assert.ok(
        panel3Text.includes('Video coming soon.'),
        'mobile-only module shows "Video coming soon." at wide width'
      );
      n += 1;

      // — Paused swap: position restored —
      const v0 = await videoOf(0);
      await v0.evaluate(async (v) => {
        v.preload = 'auto';
        v.load();
        await new Promise((res, rej) => {
          if (v.readyState >= 1) return res();
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('video load error')), { once: true });
          setTimeout(() => rej(new Error('metadata timeout')), 15000);
        });
        v.currentTime = 5;
        await new Promise((res) => {
          v.addEventListener('seeked', res, { once: true });
          setTimeout(res, 5000);
        });
        v.pause();
      });
      const tBefore = await v0.evaluate((v) => v.currentTime);
      assert.ok(tBefore >= 4.5 && tBefore <= 5.6, `position parked at ~5s before swap (got ${tBefore})`);
      n += 1;
      assert.equal(await clickFmt(0, 'mobile'), true, 'Mobile button clickable');
      n += 1;
      await waitCurrent(0, 'mobile');
      assert.equal(
        await srcOf(0),
        '/training-mobile/02-signing-in.mp4',
        'toggle to Mobile swaps the source to the mobile file'
      );
      n += 1;
      const tAfter = await (await videoOf(0)).evaluate((v) => v.currentTime);
      assert.ok(Math.abs(tAfter - tBefore) <= 1.0, `paused swap restores position within 1s (${tBefore} -> ${tAfter})`);
      n += 1;
      assert.deepEqual(await pressed(0), { main: 'false', mobile: 'true' }, 'after toggle: Mobile pressed, 16:9 not');
      n += 1;

      // — Playing swap: resumes playback near the position —
      const v0b = await videoOf(0);
      await v0b.evaluate(async (v) => {
        await v.play();
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('#training-host > .panel video[data-training-video]');
          return v && !v.paused && v.currentTime > 6.5;
        },
        { timeout: 15000, polling: 100 }
      );
      const tPlay = await (await videoOf(0)).evaluate((v) => v.currentTime);
      assert.equal(await clickFmt(0, 'main'), true, '16:9 button clickable');
      n += 1;
      await waitCurrent(0, 'main');
      await page.waitForFunction(
        () => {
          const v = document.querySelector('#training-host > .panel video[data-training-video]');
          return v && !v.paused;
        },
        { timeout: 10000, polling: 100 }
      );
      const tResumed = await (await videoOf(0)).evaluate((v) => v.currentTime);
      assert.equal(await srcOf(0), '/training/02-signing-in.mp4', 'toggle back swaps the source to the 16:9 file');
      n += 1;
      assert.ok(tResumed >= tPlay - 1.5, `playing swap resumes near the pre-swap position (${tPlay} -> ${tResumed})`);
      n += 1;
      await (await videoOf(0)).evaluate((v) => v.pause());

      // — Narrow viewport (390): Batch 194 default = mobile file —
      await page.setViewport({ width: 390, height: 844 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#sec-training:not([hidden])', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('#training-host > .panel').length === 3, {
        timeout: 15000,
        polling: 100,
      });
      assert.equal(
        await srcOf(0),
        '/training-mobile/02-signing-in.mp4',
        'narrow: both-files module defaults to the mobile file'
      );
      n += 1;
      assert.deepEqual(await pressed(0), { main: 'false', mobile: 'true' }, 'narrow: Mobile pressed, 16:9 not');
      n += 1;
      assert.equal(await clickFmt(0, 'main'), true, '16:9 button clickable at narrow width');
      n += 1;
      await waitCurrent(0, 'main');
      assert.equal(
        await srcOf(0),
        '/training/02-signing-in.mp4',
        'narrow: toggle to 16:9 swaps the source to the main file'
      );
      n += 1;
      assert.equal(
        await srcOf(1),
        '/training/03-finding-your-way-around.mp4',
        'main-only module plays its file (narrow)'
      );
      n += 1;
      assert.equal((await fmtBtns(1)).length, 0, 'main-only module still has NO switch (narrow)');
      n += 1;
      assert.equal(
        await srcOf(2),
        '/training-mobile/03-finding-your-way-around.mp4',
        'mobile-only module plays its file (narrow)'
      );
      n += 1;
      assert.equal((await fmtBtns(2)).length, 0, 'mobile-only module still has NO switch (narrow)');
      n += 1;

      assert.equal(errors.length, 0, `no page errors: ${errors.join('; ')}`);
      n += 1;
      group('Part 2 browser (defaults, toggle, position, single-file)', n);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
    }
  }

  console.log(JSON.stringify({ passed: true, groups: groups.length, checks: groups }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
