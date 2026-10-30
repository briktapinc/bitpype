'use strict';
/**
 * Batch 86 — LOGO LOCKUP CORRECTION (Ely, 2026-10-30: "i gave you a
 * white and black logo, use the white for dark backgrounds and black
 * for light backgrounds").
 *
 * Batch 83 shipped the official logo but, misreading Ely's uploads,
 * placed a mark-only icon + styled text wordmark on light surfaces.
 * Ely's two uploads are BOTH full lockups (teal mark + BITPYPE +
 * TECHNOLOGY): one with a WHITE wordmark, one with a BLACK wordmark.
 * This batch applies the rule literally:
 *
 *   public/brand/logo-white.png  white lockup — DARK surfaces only
 *   public/brand/logo-black.png  black lockup — LIGHT surfaces
 *   public/brand/logo-email.png  black lockup as-is, email-sized
 *
 * Every light-surface placement Batch 83 did with the mark icon is
 * redone with the black lockup as-is (staff auth screens, portal,
 * marketing headers + light footers, legal/SMS pages, /solo +
 * /onboarding headers, transactional brand lines). Dark surfaces
 * keep the white lockup (staff sidebar, /how footer band, /solo +
 * /onboarding dark footers). The Batch 83 derivative names
 * (logo-full / logo-mark / logo-light) are retired; the masters in
 * the repo are byte-identical to Ely's renamed uploads
 * (bitpype-logo-official-white.png / -black.png).
 *
 *   Part A — asset pins (masters, email derivative, retirements).
 *   Part B — Ely's rule pinned per surface; the mark-icon workaround
 *     is gone from every chrome file.
 *   Part C — booted server: lockups serve, retired assets 404, key
 *     pages carry the right variant, the branded email renders the
 *     black lockup at the corrected aspect.
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b86-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch86', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');
delete process.env.BITPYPE_EMAIL_LOGO_URL;

const PORT = 31486;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const count = (s, sub) => String(s).split(sub).length - 1;

/* Surfaces whose chrome is LIGHT — black lockup, never the white one. */
const LIGHT_ONLY = [
  'public/portal.html',
  'public/home.html',
  'public/landing.html',
  'public/how-it-works.html',
  'public/creator.html',
  'public/partner.html',
  'public/thankyou.html',
  'public/work-with-us.html',
  'public/authorize.html',
  'public/website-promo.html',
  'public/legal/terms.html',
  'public/legal/privacy.html',
  'public/sms-policy.html',
  'public/claim.html',
  'public/domain-picker.html',
  'public/domain-success.html',
  'public/member-reset.html',
  /* public/js/app.js removed from LIGHT_ONLY in the Batch 88 combined
     close: its only lockups are the two AUTH GATE brands, and Ely's
     2026-10-30 screenshot ruling puts the gate on the DARK ground —
     the auth brands use the white lockup (pinned in batch87 A7). */
];
/* Light header + DARK footer band — both lockups, each on its ground. */
const BOTH = ['public/how.html', 'public/solo.html', 'public/onboarding.html'];
/* Every chrome file that carried the Batch 83 mark-icon workaround. */
const CHROME = [...LIGHT_ONLY, ...BOTH, 'public/index.html', 'public/styles.css', 'src/emailTemplate.js'];

/* ===================================================================== */
/* Part A — assets                                                        */
/* ===================================================================== */

function partA() {
  check('A1 renamed masters are in the repo at 450x120 and differ', () => {
    const white = fs.readFileSync(path.join(root, 'public/brand/logo-white.png'));
    const black = fs.readFileSync(path.join(root, 'public/brand/logo-black.png'));
    for (const [name, buf] of [['logo-white.png', white], ['logo-black.png', black]]) {
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${name} is a PNG`);
      assert.equal(buf.readUInt32BE(16), 450, `${name} width 450`);
      assert.equal(buf.readUInt32BE(20), 120, `${name} height 120`);
    }
    assert.ok(!white.equals(black), 'white and black lockups are different files');
  });

  check('A2 email lockup is the black lockup as-is at 360x96', () => {
    const buf = fs.readFileSync(path.join(root, 'public/brand/logo-email.png'));
    assert.equal(buf.readUInt32BE(16), 360, 'logo-email.png width 360');
    assert.equal(buf.readUInt32BE(20), 96, 'logo-email.png height 96 (full lockup, uncropped)');
  });

  check('A3 Batch 83 derivative names are retired from disk', () => {
    for (const f of ['logo-full.png', 'logo-mark.png', 'logo-light.png']) {
      assert.ok(!fs.existsSync(path.join(root, 'public/brand', f)), `${f} removed`);
    }
  });
}

/* ===================================================================== */
/* Part B — Ely's rule, pinned per surface                                */
/* ===================================================================== */

function partB() {
  check('B1 light surfaces carry the BLACK lockup and never the white', () => {
    for (const rel of LIGHT_ONLY) {
      const src = read(rel);
      assert.ok(src.includes('/brand/logo-black.png'), `${rel} uses logo-black.png`);
      assert.ok(!src.includes('/brand/logo-white.png'), `${rel} must not use the white lockup`);
    }
  });

  check('B2 mixed pages put black on light headers, white on dark footers', () => {
    for (const rel of BOTH) {
      const src = read(rel);
      assert.ok(src.includes('/brand/logo-black.png'), `${rel} header uses logo-black.png`);
      assert.ok(src.includes('/brand/logo-white.png'), `${rel} dark footer uses logo-white.png`);
    }
  });

  check('B3 staff shell sidebar (dark) carries the WHITE lockup only', () => {
    const html = read('public/index.html');
    assert.ok(html.includes('/brand/logo-white.png'), 'sidebar uses logo-white.png');
    assert.ok(!html.includes('/brand/logo-black.png'), 'shell must not use the black lockup');
  });

  check('B4 the Batch 83 mark-icon workaround is gone from all chrome', () => {
    for (const rel of CHROME) {
      assert.ok(!read(rel).includes('/brand/logo-icon.png'), `${rel} must not reference logo-icon.png`);
    }
  });

  check('B5 auth lockup is styled; email header renders the lockup at 180x48', () => {
    assert.ok(read('public/styles.css').includes('.auth-logo-lockup'), 'styles.css sizes the auth lockup');
    assert.equal(count(read('public/js/app.js'), 'auth-logo-lockup'), 2, 'both auth screens use the lockup');
    const tpl = read('src/emailTemplate.js');
    assert.ok(tpl.includes('width="180" height="48"'), 'email img uses the true 3.75:1 aspect');
    assert.ok(tpl.includes('/brand/logo-email.png'), 'email logo path unchanged (Batch 56 resolver)');
  });
}

/* ===================================================================== */
/* Part C — booted server                                                 */
/* ===================================================================== */

async function seed() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const platform = require(path.join(root, 'server/platform.js'));
  await platform.setPlatformSetting('general.public_url', 'https://bitpype.test');
}

async function partC() {
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

    await checkAsync('C1 both lockups serve 200 image/png; retired names 404', async () => {
      for (const p of ['/brand/logo-white.png', '/brand/logo-black.png', '/brand/logo-email.png']) {
        const r = await fetch(BASE + p);
        assert.equal(r.status, 200, `${p} serves 200`);
        assert.ok((r.headers.get('content-type') || '').includes('image/png'), `${p} is image/png`);
        await r.arrayBuffer();
      }
      for (const p of ['/brand/logo-full.png', '/brand/logo-light.png', '/brand/logo-mark.png']) {
        const r = await fetch(BASE + p);
        const ct = r.headers.get('content-type') || '';
        assert.ok(r.status !== 200 || !ct.includes('image/png'), `${p} is retired (not served as an image)`);
        await r.arrayBuffer();
      }
    });

    await checkAsync('C2 key pages serve the variant Ely specified for their ground', async () => {
      const pages = [
        ['/', 'logo-black.png'],
        ['/app', 'logo-white.png'],
        ['/portal', 'logo-black.png'],
        ['/solo', 'logo-black.png'],
        ['/legal/terms.html', 'logo-black.png'],
      ];
      for (const [p, needle] of pages) {
        const r = await fetch(BASE + p, { redirect: 'follow' });
        assert.equal(r.status, 200, `${p} serves 200`);
        const html = await r.text();
        assert.ok(html.includes(`/brand/${needle}`), `${p} carries ${needle}`);
        assert.ok(!html.includes('/brand/logo-icon.png'), `${p} has no mark-icon reference`);
      }
    });

    await checkAsync('C3 branded email renders the black lockup (absolute URL, 180x48)', async () => {
      const tpl = require(path.join(root, 'src/emailTemplate.js'));
      assert.equal(tpl.LOGO_URL, 'https://bitpype.test/brand/logo-email.png');
      const { html } = tpl.renderBrandedEmail({ title: 'Batch 86 proof', paragraphs: ['Hello from the fixture.'] });
      assert.ok(html.includes('src="https://bitpype.test/brand/logo-email.png"'), 'email header img is the lockup, absolute');
      assert.ok(html.includes('width="180" height="48"'), 'email header img at the corrected aspect');
    });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/* ===================================================================== */

(async () => {
  partA();
  partB();
  await seed();
  await partC();
  console.log(`batch86 logo-lockup-correction checks passed (${results.length}):`);
  for (const r of results) console.log('  - ' + r);
})().catch((e) => {
  console.error('batch86 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
