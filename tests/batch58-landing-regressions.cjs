'use strict';
/**
 * Batch 58 — /landing: the page that sells the BitPype SOFTWARE to
 * prospective agency owners.
 *
 * What shipped:
 *   - GET /landing (+ /landing.html) — a templated marketing page in
 *     the /how-it-works shell (Batch 56 tokens: {{PUBLIC_URL}} /
 *     {{SUPPORT_EMAIL}} substituted at serve time; the Batch 56 census
 *     pin — exactly ONE production-domain literal in shipped code, the
 *     general.public_url def — must still hold).
 *   - An interest form (full name + email + phone) posting to
 *     POST /api/v1/landing/submit: Turnstile + the shared per-IP rate
 *     limiter + a lead created through the lead engine in ws1, marked
 *     source 'landing-software' (source_ref 'landing', group/category
 *     'Software interest'). A repeat submission for the same email
 *     FOLDS into the existing lead (one email = one lead) and records a
 *     landing_software_interest event — never a duplicate.
 *   - A videos section driven by the platform setting
 *     landing.video_embeds (Admin → Settings → Landing). Ely pastes a
 *     YouTube embed code / watch URL / youtu.be link / bare ID;
 *     server/landingVideos.js extracts the ID at BOTH save choke points
 *     (settingsKeys.validateSetting + platform.setPlatformSetting) and
 *     only canonical IDs are stored. The page builds its own
 *     youtube-nocookie iframes — pasted HTML is never stored/rendered.
 *     Empty list → the section does not render at all.
 *
 * NEGATIVE PROOF (run at build time): pointing the extractor at a
 * non-YouTube (Vimeo) iframe is asserted rejected below; during the
 * build, a shim that accepted any iframe src made those checks fail —
 * restored, green.
 *
 * Harness: unit checks + HTTP tests against the real server booted on
 * temp platform/workspace DBs (batch53/54 pattern). No live server, no
 * real leads. Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b58-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch58', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const PORT = 31458;
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

const ID_A = 'dQw4w9WgXcQ';
const ID_B = 'aqz-KE-bpKQ';
const ID_C = 'e-ORhEE9VVg';
const EMBED_A = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${ID_A}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay" allowfullscreen></iframe>`;

/* ===================================================================== */
/* Part A — video extractor / validator (unit)                            */
/* ===================================================================== */

function partA() {
  const lv = require(path.join(root, 'server/landingVideos.js'));

  check('extractor: embed code, watch URL, youtu.be, shorts, nocookie and bare ID all yield the same ID', () => {
    assert.equal(lv.extractYouTubeVideoId(EMBED_A), ID_A);
    assert.equal(lv.extractYouTubeVideoId(`https://www.youtube.com/watch?v=${ID_A}&t=42s`), ID_A);
    assert.equal(lv.extractYouTubeVideoId(`https://youtu.be/${ID_A}?si=xyz`), ID_A);
    assert.equal(lv.extractYouTubeVideoId(`https://www.youtube.com/shorts/${ID_A}`), ID_A);
    assert.equal(lv.extractYouTubeVideoId(`https://www.youtube-nocookie.com/embed/${ID_A}`), ID_A);
    assert.equal(lv.extractYouTubeVideoId(ID_A), ID_A);
  });

  check('parser: mixed list canonicalizes to deduped IDs', () => {
    const stored = lv.validateLandingVideoEmbedsSetting(
      [EMBED_A, `https://www.youtube.com/watch?v=${ID_B}`, `https://youtu.be/${ID_A}`, ID_C].join('\n')
    );
    assert.deepEqual(JSON.parse(stored), [ID_A, ID_B, ID_C]);
  });

  check('parser: empty / blank → empty list (section stays dormant)', () => {
    assert.equal(lv.validateLandingVideoEmbedsSetting(''), '[]');
    assert.equal(lv.validateLandingVideoEmbedsSetting('   '), '[]');
    assert.deepEqual(lv.parseStoredLandingVideoEmbeds('[]'), []);
    assert.equal(lv.landingVideosSectionHtml([]), '');
  });

  check('NEGATIVE: a non-YouTube (Vimeo) iframe is rejected, coded VALIDATION', () => {
    assert.throws(
      () => lv.parseLandingVideoEmbeds('<iframe src="https://player.vimeo.com/video/123456789" width="640" height="360"></iframe>'),
      (e) => e.code === 'VALIDATION'
    );
    assert.equal(lv.extractYouTubeVideoId('https://player.vimeo.com/video/123456789'), null);
  });

  check('validator matrix: script tag, random HTML, vimeo URL and plain text are all rejected', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<div><p>hello</p></div>',
      'https://vimeo.com/123456789',
      'just some words',
      `https://www.youtube.com/watch?v=tooshort`,
      JSON.stringify(['https://example.com/not-a-video']),
    ]) {
      assert.throws(() => lv.parseLandingVideoEmbeds(bad), (e) => e.code === 'VALIDATION', bad);
    }
  });

  check('section builder: N stored IDs → N youtube-nocookie iframes, IDs only, no stored HTML', () => {
    const html = lv.landingVideosSectionHtml([ID_A, ID_B, ID_C]);
    assert.equal((html.match(/<iframe /g) || []).length, 3);
    for (const id of [ID_A, ID_B, ID_C]) {
      assert.ok(html.includes(`https://www.youtube-nocookie.com/embed/${id}`), id);
    }
    assert.ok(!html.includes('youtube.com/embed'), 'no non-nocookie embed host');
  });

  check('settingsKeys: landing.video_embeds is writable and validates through the Batch 24b path', () => {
    const sk = require(path.join(root, 'server/settingsKeys.js'));
    assert.ok(sk.SETTABLE_KEYS.includes('landing.video_embeds'));
    const ok = sk.validateSetting('landing.video_embeds', `https://youtu.be/${ID_A}`);
    assert.equal(ok.ok, true);
    assert.equal(ok.value, JSON.stringify([ID_A]));
    const bad = sk.validateSetting('landing.video_embeds', 'https://vimeo.com/123456789');
    assert.equal(bad.ok, false);
  });

  check('platform def: landing.video_embeds exists in the landing group with an empty-list default', () => {
    const platform = require(path.join(root, 'server/platform.js'));
    const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'landing.video_embeds');
    assert.ok(def, 'def present');
    assert.equal(def.group, 'landing');
    assert.equal(def.default, '[]');
  });
}

/* ===================================================================== */
/* Part B — static wiring + the Batch 56 census pin                       */
/* ===================================================================== */

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function partB() {
  check('census: still exactly one production-domain literal in shipped code (Batch 56 pin holds)', () => {
    const hits = [];
    for (const tree of ['src', 'server', 'public']) {
      for (const file of walk(path.join(root, tree))) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const m = line.match(/bitpype\.com/g);
          if (m) hits.push({ file: path.relative(root, file), line: i + 1, count: m.length });
        });
      }
    }
    const total = hits.reduce((n, h) => n + h.count, 0);
    assert.equal(total, 1, `expected exactly 1, found ${total}: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].file, path.join('server', 'platform.js'));
  });

  check('page: landing.html carries the tokens, the form fields and no baked domain', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'landing.html'), 'utf8');
    assert.ok(html.includes('{{PUBLIC_URL}}'), 'public URL token');
    assert.ok(html.includes('{{SUPPORT_EMAIL}}'), 'support email token');
    assert.ok(html.includes('{{LANDING_VIDEOS}}'), 'videos token');
    assert.ok(html.includes('id="landing-form"'), 'interest form');
    assert.ok(html.includes('name="fullName"') && html.includes('name="email"') && html.includes('name="phone"'), 'name/email/phone fields');
    assert.ok(html.includes('/api/v1/landing/submit'), 'posts to the landing route');
    assert.ok(html.includes('/js/captcha.js'), 'shared Turnstile helper');
    assert.ok(html.includes('Win clients') && html.includes('Build &amp; launch sites') && html.includes('Run the business') && html.includes('Powered by AI'), 'four verified feature groups');
    assert.ok(html.includes('20 native modules'), 'module catalog claim matches MODULE_TYPES');
  });

  check('wiring: server.js mounts the landing API + page; admin renders the Landing tab + helper text', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("require('./server/routes/landing')"), 'route module required');
    assert.ok(serverSrc.includes("app.use('/api/v1/landing', landingRoutes)"), 'API mounted');
    assert.ok(serverSrc.includes("app.get(['/landing', '/landing/']"), 'page route');
    assert.ok(serverSrc.includes('sendLandingPage'), 'videos substitution at serve time');
    const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appSrc.includes("d.key === 'landing.video_embeds'") || appSrc.includes("'landing.video_embeds'"), 'admin special render');
    assert.ok(appSrc.includes('Paste a YouTube embed code or link'), 'admin helper text');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'landing.js'), 'utf8');
    assert.ok(routeSrc.includes("source: 'landing-software'"), 'lead marker');
    assert.ok(routeSrc.includes('requireCaptcha') && routeSrc.includes('rateLimit'), 'captcha + limiter armor');
  });
}

/* ===================================================================== */
/* Part C — HTTP: page, form, fold, videos                                */
/* ===================================================================== */

async function partC() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Landing Fixture', 'landing-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  const leadCount = () => wdb.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  const platform = require(path.join(root, 'server/platform.js'));

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

    const post = async (p, body) => {
      const res = await fetch(BASE + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text };
    };
    const getText = async (p) => {
      const res = await fetch(BASE + p);
      return { status: res.status, text: await res.text() };
    };

    await checkAsync('GET /landing → 200, tokens substituted, no videos section while the list is empty', async () => {
      const r = await getText('/landing');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('Start your own'), 'hero present');
      assert.ok(!r.text.includes('{{'), 'zero token leakage');
      assert.ok(!r.text.includes('id="videos"'), 'videos section dormant-empty');
      assert.ok(!r.text.includes('<iframe'), 'no iframes at all');
    });

    await checkAsync('GET /landing.html is intercepted the same way (no raw tokens)', async () => {
      const r = await getText('/landing.html');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('{{'));
    });

    await checkAsync('form validation matrix: missing name / bad email / missing phone → coded 400, nothing written', async () => {
      for (const body of [
        { email: 'ada@example.invalid', phone: '610-555-0101' },
        { fullName: 'Ada Lovelace', email: 'not-an-email', phone: '610-555-0101' },
        { fullName: 'Ada Lovelace', email: 'ada@example.invalid' },
        {},
      ]) {
        const r = await post('/api/v1/landing/submit', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json.code, 'VALIDATION');
        assert.equal(r.json.ok, false);
      }
      assert.equal(leadCount(), 0, 'no lead written by invalid submissions');
    });

    let leadId = null;
    await checkAsync('valid submission creates exactly ONE ws1 lead with the software-interest marker', async () => {
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Ada Lovelace',
        email: 'ada@example.invalid',
        phone: '+1 610-555-0101',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      leadId = r.json.data.id;
      assert.ok(Number.isInteger(leadId) && leadId > 0);
      assert.equal(leadCount(), 1);
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      assert.equal(row.business_name, 'Ada Lovelace');
      assert.equal(row.email, 'ada@example.invalid');
      assert.equal(row.phone, '+1 610-555-0101');
      assert.equal(row.source, 'landing-software');
      assert.equal(row.source_ref, 'landing');
      assert.equal(row.lead_group, 'Software interest');
      // The lead engine canonicalizes category casing on every write
      // path (validateLeadInput) — 'Software interest' lands title-case.
      assert.equal(row.category, 'Software Interest');
      assert.ok(row.notes.includes('Interested in the BitPype software / agency license'), 'interest note');
      const tags = JSON.parse(row.tags || '[]');
      assert.ok(tags.includes('landing-software') && tags.includes('software-interest'), 'tags');
    });

    await checkAsync('repeat submission with the same email folds — no second lead, polite success, interest event recorded', async () => {
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Ada L.',
        email: 'ADA@example.invalid',
        phone: '+1 610-555-9999',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.id, leadId, 'same lead id returned');
      assert.equal(leadCount(), 1, 'still exactly one lead');
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      assert.equal(row.phone, '+1 610-555-0101', 'existing phone not overwritten by the fold');
      const ev = wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'landing_software_interest'")
        .get(leadId);
      assert.equal(ev.c, 1, 'interest event recorded on the folded lead');
    });

    await checkAsync('videos: saving embed code + watch URL renders exactly those youtube-nocookie iframes', async () => {
      await platform.setPlatformSetting(
        'landing.video_embeds',
        `${EMBED_A}\nhttps://www.youtube.com/watch?v=${ID_B}`
      );
      const stored = await platform.getPlatformSetting('landing.video_embeds', '[]');
      assert.deepEqual(JSON.parse(stored), [ID_A, ID_B], 'only canonical IDs stored — pasted HTML is gone');
      const r = await getText('/landing');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('id="videos"'), 'section renders when videos exist');
      assert.equal((r.text.match(/youtube-nocookie\.com\/embed\//g) || []).length, 2);
      assert.ok(r.text.includes(`youtube-nocookie.com/embed/${ID_A}`));
      assert.ok(r.text.includes(`youtube-nocookie.com/embed/${ID_B}`));
      assert.ok(!r.text.includes('{{'), 'still zero token leakage');
    });

    await checkAsync('videos: clearing the setting hides the section again', async () => {
      await platform.setPlatformSetting('landing.video_embeds', '');
      const r = await getText('/landing');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('id="videos"'));
    });

    await checkAsync('videos: a non-YouTube save through the platform choke point is rejected and changes nothing', async () => {
      await assert.rejects(
        () => platform.setPlatformSetting('landing.video_embeds', '<iframe src="https://player.vimeo.com/video/123456789"></iframe>'),
        (e) => e.code === 'VALIDATION'
      );
      const stored = await platform.getPlatformSetting('landing.video_embeds', '[]');
      assert.equal(stored, '[]');
    });

    await checkAsync('config endpoint answers with the captcha posture', async () => {
      const res = await fetch(`${BASE}/api/v1/landing/config`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.data.captcha, 'captcha config present');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

async function main() {
  partA();
  partB();
  await partC();
  console.log(JSON.stringify({ batch58: true, checks: results.length, passed: true }));
  for (const name of results) console.log('  ✓ ' + name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
