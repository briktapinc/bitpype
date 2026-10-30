'use strict';
/**
 * Batch 83 — OFFICIAL BitPype logo wired into every platform surface
 * (Ely, 2026-10-30: "This is the official bitpype logo, add it to the
 * app, emails, etc.").
 *
 * Ely supplied the official logo (450x120 transparent PNGs): a teal
 * hexagon mark + "BITPYPE" italic wordmark + "TECHNOLOGY" subline.
 * The wordmark ships in two variants — WHITE (for dark surfaces) and
 * BLACK (for light surfaces) — so placement is legibility-driven:
 *
 *   public/brand/logo-full.png   master: white lockup (dark surfaces)
 *   public/brand/logo-mark.png   master: as supplied (black wordmark)
 *   public/brand/logo-light.png  light lockup (mark + black wordmark)
 *   public/brand/logo-email.png  email-sized light lockup
 *   public/brand/logo-icon.png   mark-only square icon
 *   public/brand/favicon.*       favicon set from the mark
 *   public/brand/og-image.png    lockup on dark, 1200x630 social card
 *
 * Surfaces covered: staff app shell (dark sidebar -> white lockup),
 * staff auth screens (mark icon), client portal (mark icon), every
 * marketing page header (mark icon) + favicon + og:image, legal/SMS
 * pages, /solo + /onboarding brand blocks, transactional flow pages,
 * and the shared branded-email wrapper (light lockup, absolute URL).
 * The old BP-tile mark (brand/bitpype-mark.svg) stays on disk for
 * compatibility but is no longer referenced by any user-facing
 * surface. Customer websites keep their own branding — untouched.
 *
 *   Part A — brand assets exist and are well-formed.
 *   Part B — source pins per surface; zero user-facing references
 *     to the old mark.
 *   Part C — booted server: assets serve 200, key pages carry the
 *     new logo, and the branded email renders the new lockup with an
 *     absolute URL from the canonical public URL (Batch 56 resolver).
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b83-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch83', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');
delete process.env.BITPYPE_EMAIL_LOGO_URL;

const PORT = 31483;
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

const MARKETING = [
  'public/home.html',
  'public/landing.html',
  'public/how-it-works.html',
  'public/how.html',
  'public/creator.html',
  'public/partner.html',
  'public/work-with-us.html',
  'public/thankyou.html',
  'public/website-promo.html',
  'public/authorize.html',
];
const LEGAL = ['public/legal/terms.html', 'public/legal/privacy.html', 'public/sms-policy.html'];

/* ===================================================================== */
/* Part A — assets                                                        */
/* ===================================================================== */

function partA() {
  const pngs = [
    'logo-white.png',
    'logo-black.png',
    'logo-icon.png',
    'logo-email.png',
    'og-image.png',
    'favicon.png',
    'apple-touch-icon.png',
  ];
  check('A1 brand assets exist with PNG signatures', () => {
    for (const f of pngs) {
      const buf = fs.readFileSync(path.join(root, 'public/brand', f));
      assert.ok(buf.length > 500, `${f} has content (${buf.length} bytes)`);
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${f} is a PNG`);
    }
    const ico = fs.readFileSync(path.join(root, 'public/brand/favicon.ico'));
    assert.ok(ico.length > 500, 'favicon.ico has content');
    assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], 'favicon.ico is an ICO');
  });

  check('A2 masters are the official 450x120 uploads; old mark file retained on disk', () => {
    for (const f of ['logo-white.png', 'logo-black.png']) {
      const buf = fs.readFileSync(path.join(root, 'public/brand', f));
      assert.equal(buf.readUInt32BE(16), 450, `${f} width 450`);
      assert.equal(buf.readUInt32BE(20), 120, `${f} height 120`);
    }
    assert.ok(fs.existsSync(path.join(root, 'public/brand/bitpype-mark.svg')), 'old mark kept on disk');
  });
}

/* ===================================================================== */
/* Part B — source pins                                                   */
/* ===================================================================== */

function partB() {
  check('B1 staff shell (dark sidebar) carries the white lockup + favicon', () => {
    const html = read('public/index.html');
    assert.ok(html.includes('/brand/logo-white.png'), 'sidebar uses logo-white.png');
    assert.ok(html.includes('/brand/favicon.ico'), 'staff shell favicon updated');
    assert.ok(!html.includes('>BP</span>'), 'BP text tile gone from the shell brand');
  });

  check('B2 staff auth screens use the white lockup (dark gate — Ely 2026-10-30 screenshot ruling; no BP tile span left in app.js)', () => {
    const appJs = read('public/js/app.js');
    assert.ok(appJs.includes('/brand/logo-white.png'), 'auth brand uses logo-white.png');
    assert.ok(!appJs.includes('>BP</span>'), 'no BP tile span remains');
  });

  check('B3 portal gate + topbar use the black lockup', () => {
    const portal = read('public/portal.html');
    assert.ok(count(portal, '/brand/logo-black.png') >= 2, 'both portal logo spots use the black lockup');
    assert.ok(portal.includes('/brand/favicon.ico'), 'portal favicon updated');
  });

  check('B4 marketing pages: black lockup header, new favicon, og:image on the dark card', () => {
    for (const rel of MARKETING) {
      const html = read(rel);
      assert.ok(html.includes('/brand/logo-black.png'), `${rel} header uses logo-black.png`);
      assert.ok(html.includes('/brand/favicon.ico'), `${rel} favicon updated`);
      if (html.includes('og:image')) {
        assert.ok(html.includes('/brand/og-image.png'), `${rel} og:image uses og-image.png`);
      }
    }
  });

  check('B5 legal + SMS policy pages use the black lockup on their light brand line', () => {
    for (const rel of LEGAL) {
      const html = read(rel);
      assert.ok(html.includes('/brand/logo-black.png'), `${rel} uses logo-black.png`);
    }
  });

  check('B6 /solo + /onboarding brand blocks use the full lockups (B tile gone)', () => {
    for (const rel of ['public/solo.html', 'public/onboarding.html']) {
      const html = read(rel);
      assert.ok(html.includes('/brand/logo-black.png'), `${rel} header uses logo-black.png`);
      assert.ok(html.includes('/brand/logo-white.png'), `${rel} dark footer uses logo-white.png`);
      assert.ok(!html.includes('<span class="mark">B</span>'), `${rel} B tile removed`);
    }
  });

  check('B7 transactional flow pages carry the black lockup in their brand line', () => {
    for (const rel of ['public/claim.html', 'public/domain-picker.html', 'public/domain-success.html', 'public/member-reset.html']) {
      const html = read(rel);
      assert.ok(html.includes('/brand/logo-black.png'), `${rel} brand line uses logo-black.png`);
    }
  });

  check('B8 shared email wrapper resolves the new email lockup', () => {
    const tpl = read('src/emailTemplate.js');
    assert.ok(tpl.includes('/brand/logo-email.png'), 'logoUrl defaults to logo-email.png');
    assert.ok(tpl.includes('<img src="${escapeHtml(logoUrl())}"'), 'header renders the logo image');
  });

  check('B9 NO user-facing surface references the old mark any more', () => {
    const files = [
      ...MARKETING,
      ...LEGAL,
      'public/index.html',
      'public/portal.html',
      'public/solo.html',
      'public/onboarding.html',
      'public/claim.html',
      'public/domain-picker.html',
      'public/domain-success.html',
      'public/member-reset.html',
      'public/design-change.html',
      'public/social-approve.html',
      'public/js/app.js',
      'src/emailTemplate.js',
    ];
    for (const rel of files) {
      assert.ok(!read(rel).includes('bitpype-mark'), `${rel} must not reference bitpype-mark`);
    }
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

    await checkAsync('C1 brand assets serve 200 with image types', async () => {
      const cases = [
        ['/brand/logo-white.png', 'image/png'],
        ['/brand/logo-black.png', 'image/png'],
        ['/brand/logo-icon.png', 'image/png'],
        ['/brand/logo-email.png', 'image/png'],
        ['/brand/og-image.png', 'image/png'],
        ['/brand/favicon.ico', 'image/x-icon'],
        ['/brand/apple-touch-icon.png', 'image/png'],
      ];
      for (const [p, type] of cases) {
        const r = await fetch(BASE + p);
        assert.equal(r.status, 200, `${p} serves 200`);
        assert.ok((r.headers.get('content-type') || '').includes(type), `${p} is ${type}`);
        await r.arrayBuffer();
      }
    });

    await checkAsync('C2 key pages serve the new logo and no old mark', async () => {
      const pages = [
        ['/', 'logo-black.png'],
        ['/app', 'logo-white.png'],
        ['/portal', 'logo-black.png'],
        ['/landing', 'logo-black.png'],
        ['/solo', 'logo-black.png'],
        ['/onboarding', 'logo-black.png'],
        ['/legal/terms.html', 'logo-black.png'],
        ['/sms-policy', 'logo-black.png'],
      ];
      for (const [p, needle] of pages) {
        const r = await fetch(BASE + p, { redirect: 'follow' });
        assert.equal(r.status, 200, `${p} serves 200`);
        const html = await r.text();
        assert.ok(html.includes(`/brand/${needle}`), `${p} carries ${needle}`);
        assert.ok(!html.includes('bitpype-mark'), `${p} has no old mark reference`);
      }
    });

    await checkAsync('C3 branded email renders the new lockup at an absolute canonical URL', async () => {
      const tpl = require(path.join(root, 'src/emailTemplate.js'));
      assert.equal(tpl.LOGO_URL, 'https://bitpype.test/brand/logo-email.png');
      const { html } = tpl.renderBrandedEmail({ title: 'Batch 83 proof', paragraphs: ['Hello from the fixture.'] });
      assert.ok(html.includes('src="https://bitpype.test/brand/logo-email.png"'), 'email header img is the new lockup, absolute');
      assert.ok(!html.includes('bitpype-mark'), 'no old mark in email HTML');
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
  console.log(`batch83 official-logo checks passed (${results.length}):`);
  for (const r of results) console.log('  - ' + r);
})().catch((e) => {
  console.error('batch83 FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
