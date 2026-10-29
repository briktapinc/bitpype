'use strict';
/**
 * Batch 70 — /landing follow-through: thank-you email + /thankyou page.
 *
 * Ely's ask (2026-10-29): when a visitor fills the form on /landing,
 *   1. send them a thank-you email (they will hear back shortly),
 *   2. redirect them to a new page /thankyou,
 *   3. /thankyou shows a demo video + a Calendly booking button, both
 *      from NEW platform settings Ely pastes in Admin → Settings →
 *      Landing: landing.thankyou_video (single YouTube video, stored
 *      as the canonical ID via the Batch 58 parser) and
 *      landing.thankyou_calendly_url (https on calendly.com only).
 *
 * What is pinned here:
 *   - The email helper (server/landingThankYou.js) builds honest copy
 *     (thanks + "hear back shortly", first-name greeting) and its send
 *     is best-effort: a stubbed mailer failure returns {sent:false} and
 *     NEVER throws (Batch 61/63 deps-injection pattern).
 *   - The submit route calls the helper on BOTH paths (new lead and
 *     DUPLICATE_EMAIL fold), returns redirectUrl '/thankyou', and a
 *     throwing mailer still yields a 200 success (in-process route
 *     test with the helper stubbed).
 *   - Settings validation at BOTH choke points (settingsKeys +
 *     platform.setPlatformSetting): non-YouTube video input, multiple
 *     videos, non-Calendly / non-https / credential / script-y
 *     Calendly input are all coded VALIDATION rejections.
 *   - /thankyou over real HTTP: dormant state renders cleanly (no
 *     iframe, no Calendly, no token leakage, no raw setting text);
 *     with both settings set it renders the youtube-nocookie iframe
 *     built from the stored ID + the "Book your appointment" CTA;
 *     cleared again → dormant. A live-shaped submit over HTTP (mail
 *     unconfigured in the fixture) still succeeds with redirectUrl.
 *   - The Batch 56 census pin still holds: exactly ONE production-
 *     domain literal in shipped code.
 *   - Calendly renders as a CTA button only: the official inline
 *     embed's widget script (assets.calendly.com) is NOT in the global
 *     CSP script-src, and this batch does not loosen it — pinned by
 *     asserting the served page carries no calendly script tag and
 *     securityHeaders.js gains no calendly host.
 *
 * Harness: unit checks + an in-process route mount + HTTP tests
 * against the real server booted on temp DBs (batch58 pattern). No
 * live server, no real leads, no real mail.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b70-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch70', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const PORT = 31470;
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
const EMBED_A = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${ID_A}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`;
const CAL_URL = 'https://calendly.com/bitpype-demo/intro-call';

/* ===================================================================== */
/* Part A — validators, sections, email (unit)                            */
/* ===================================================================== */

function partA() {
  const lt = require(path.join(root, 'server/landingThankYou.js'));

  check('video validator: embed code, watch URL, youtu.be and bare ID all store the bare ID', () => {
    assert.equal(lt.validateThankYouVideoSetting(EMBED_A), ID_A);
    assert.equal(lt.validateThankYouVideoSetting(`https://www.youtube.com/watch?v=${ID_A}&t=9s`), ID_A);
    assert.equal(lt.validateThankYouVideoSetting(`https://youtu.be/${ID_A}?si=x`), ID_A);
    assert.equal(lt.validateThankYouVideoSetting(ID_A), ID_A);
    assert.equal(lt.validateThankYouVideoSetting(''), '');
    assert.equal(lt.validateThankYouVideoSetting('   '), '');
    assert.equal(lt.validateThankYouVideoSetting(null), '');
  });

  check('video validator: non-YouTube, multi-video and script-y input are coded VALIDATION rejections', () => {
    for (const bad of [
      'https://vimeo.com/123456789',
      '<iframe src="https://player.vimeo.com/video/123456789"></iframe>',
      '<script>alert(1)</script>',
      `${ID_A} ${ID_B}`,
      `https://youtu.be/${ID_A}\nhttps://youtu.be/${ID_B}`,
      'just some words',
      'https://www.youtube.com/watch?v=tooshort',
    ]) {
      assert.throws(() => lt.validateThankYouVideoSetting(bad), (e) => e.code === 'VALIDATION', bad);
    }
  });

  check('calendly validator: https calendly.com (and subdomains) accepted; everything else rejected', () => {
    assert.equal(lt.validateThankYouCalendlyUrl(CAL_URL), CAL_URL);
    assert.equal(lt.validateThankYouCalendlyUrl('  https://calendly.com/ely  '), 'https://calendly.com/ely');
    assert.equal(lt.validateThankYouCalendlyUrl('https://team.calendly.com/x'), 'https://team.calendly.com/x');
    assert.equal(lt.validateThankYouCalendlyUrl(''), '');
    for (const bad of [
      'http://calendly.com/ely',
      'https://notcalendly.com/ely',
      'https://calendly.com.evil.example/ely',
      'https://user:pass@calendly.com/ely',
      'javascript:alert(1)',
      'https://calendly.com/ely" onclick="alert(1)',
      '<script src="https://calendly.com/x"></script>',
      'calendly.com/ely',
      'not a url',
    ]) {
      assert.throws(() => lt.validateThankYouCalendlyUrl(bad), (e) => e.code === 'VALIDATION', bad);
    }
  });

  check('stored readers are tolerant: corrupt stored values render nothing', () => {
    assert.equal(lt.parseStoredThankYouVideoId(ID_A), ID_A);
    assert.equal(lt.parseStoredThankYouVideoId('garbage!!'), '');
    assert.equal(lt.parseStoredThankYouVideoId(''), '');
    assert.equal(lt.parseStoredThankYouCalendlyUrl(CAL_URL), CAL_URL);
    assert.equal(lt.parseStoredThankYouCalendlyUrl('https://evil.example/x'), '');
    assert.equal(lt.parseStoredThankYouCalendlyUrl(''), '');
  });

  check('sections: dormant when unset; iframe + CTA built from stored values only when set', () => {
    assert.equal(lt.thankYouSectionsHtml({}), '');
    assert.equal(lt.thankYouSectionsHtml({ videoId: '', calendlyUrl: '' }), '');
    const both = lt.thankYouSectionsHtml({ videoId: ID_A, calendlyUrl: CAL_URL });
    assert.ok(both.includes(`https://www.youtube-nocookie.com/embed/${ID_A}`), 'nocookie iframe from stored ID');
    assert.ok(!both.includes('youtube.com/embed'), 'no non-nocookie embed host');
    assert.ok(both.includes('id="thankyou-video"') && both.includes('id="thankyou-booking"'));
    assert.ok(both.includes(`href="${CAL_URL}"`), 'CTA href is the stored URL');
    assert.ok(both.includes('Book your appointment'), 'CTA label');
    assert.ok(!both.includes('<script'), 'no script injected by either section');
    const videoOnly = lt.thankYouSectionsHtml({ videoId: ID_A, calendlyUrl: '' });
    assert.ok(videoOnly.includes('thankyou-video') && !videoOnly.includes('thankyou-booking'));
    const bookingOnly = lt.thankYouSectionsHtml({ videoId: '', calendlyUrl: CAL_URL });
    assert.ok(!bookingOnly.includes('thankyou-video') && bookingOnly.includes('thankyou-booking'));
  });

  check('email builder: thanks + hear-back-shortly copy, first-name greeting, no invented claims', () => {
    const mail = lt.buildLandingThankYouEmail({ fullName: 'Ada Lovelace', email: 'ada@example.invalid' });
    assert.equal(mail.to, 'ada@example.invalid');
    assert.ok(/thank/i.test(mail.subject), 'subject thanks them');
    const body = mail.paragraphs.join('\n');
    assert.ok(body.startsWith('Hi Ada,'), 'first-name greeting');
    assert.ok(body.includes('hear back from us shortly'), 'the promised line, verbatim');
    assert.ok(body.includes('The BitPype team'), 'signed as the team');
    assert.ok(!/\d+%|guarantee|free money|#1/i.test(body), 'no invented claims');
    const anon = lt.buildLandingThankYouEmail({ fullName: '', email: 'x@example.invalid' });
    assert.ok(anon.paragraphs[0] === 'Hi there,', 'neutral greeting without a name');
    assert.equal(lt.firstNameOf('<script>alert(1)</script>'), '', 'markup-y name token never greets');
  });
}

async function partA2() {
  const lt = require(path.join(root, 'server/landingThankYou.js'));

  await checkAsync('email send: stubbed mailer receives exactly one thank-you for the submitter', async () => {
    const sent = [];
    const out = await lt.sendLandingThankYou(
      { fullName: 'Ada Lovelace', email: 'ada@example.invalid' },
      { sendMail: async (m) => sent.push(m) }
    );
    assert.deepEqual(out, { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ada@example.invalid');
    assert.ok(sent[0].paragraphs.join('\n').includes('hear back from us shortly'));
  });

  await checkAsync('email send: mailer failure is swallowed — {sent:false}, never a throw', async () => {
    const out = await lt.sendLandingThankYou(
      { fullName: 'Ada Lovelace', email: 'ada@example.invalid' },
      {
        sendMail: async () => {
          const e = new Error('Platform mail is not configured');
          e.code = 'SMTP_NOT_CONFIGURED';
          throw e;
        },
      }
    );
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'SMTP_NOT_CONFIGURED');
  });
}

/* ===================================================================== */
/* Part B — static wiring, settings choke points, census                  */
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

  check('platform defs: both thank-you settings exist in the landing group, empty defaults', () => {
    const platform = require(path.join(root, 'server/platform.js'));
    for (const key of ['landing.thankyou_video', 'landing.thankyou_calendly_url']) {
      const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === key);
      assert.ok(def, `${key} def present`);
      assert.equal(def.group, 'landing');
      assert.equal(def.default, '');
    }
    const video = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'landing.thankyou_video');
    assert.equal(video.label, 'Thank-you page demo video (YouTube)');
    const cal = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'landing.thankyou_calendly_url');
    assert.equal(cal.label, 'Thank-you page Calendly link');
  });

  check('settingsKeys: both keys settable; validation canonicalizes and rejects through the Batch 24b path', () => {
    const sk = require(path.join(root, 'server/settingsKeys.js'));
    assert.ok(sk.SETTABLE_KEYS.includes('landing.thankyou_video'));
    assert.ok(sk.SETTABLE_KEYS.includes('landing.thankyou_calendly_url'));
    const okV = sk.validateSetting('landing.thankyou_video', `https://youtu.be/${ID_A}`);
    assert.equal(okV.ok, true);
    assert.equal(okV.value, ID_A, 'stored value is the bare canonical ID');
    assert.equal(sk.validateSetting('landing.thankyou_video', 'https://vimeo.com/123').ok, false);
    const okC = sk.validateSetting('landing.thankyou_calendly_url', CAL_URL);
    assert.equal(okC.ok, true);
    assert.equal(okC.value, CAL_URL);
    assert.equal(sk.validateSetting('landing.thankyou_calendly_url', 'http://calendly.com/x').ok, false);
    assert.equal(sk.validateSetting('landing.thankyou_calendly_url', 'https://evil.example/x').ok, false);
    assert.equal(sk.validateSetting('landing.thankyou_calendly_url', '').ok, true, 'clearing is allowed');
  });

  check('wiring: server.js serves /thankyou templated; landing route + page carry the Batch 70 pieces', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("app.get(['/thankyou', '/thankyou/']"), '/thankyou route');
    assert.ok(serverSrc.includes('sendThankYouPage'), 'serve-time substitution');
    assert.ok(serverSrc.includes("landing.thankyou_video") && serverSrc.includes("landing.thankyou_calendly_url"), 'both settings read at serve time');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'landing.js'), 'utf8');
    assert.ok(routeSrc.includes('sendLandingThankYou'), 'route sends the thank-you email');
    assert.ok(routeSrc.includes("redirectUrl: '/thankyou'"), 'response carries the redirect');
    const pageSrc = fs.readFileSync(path.join(root, 'public', 'landing.html'), 'utf8');
    assert.ok(pageSrc.includes('redirectUrl'), 'landing page reads the redirect');
    assert.ok(pageSrc.includes('window.location.assign'), 'landing page navigates');
    assert.ok(pageSrc.includes('id="landing-success"'), 'inline fallback block still present');
    const tySrc = fs.readFileSync(path.join(root, 'public', 'thankyou.html'), 'utf8');
    assert.ok(tySrc.includes('{{THANKYOU_SECTIONS}}'), 'sections token');
    assert.ok(tySrc.includes('{{PUBLIC_URL}}') && tySrc.includes('{{SUPPORT_EMAIL}}'), 'Batch 56 tokens');
    assert.ok(tySrc.includes('hear back from us shortly'), 'page copy matches the promise');
    const appSrc = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
    assert.ok(appSrc.includes("'landing.thankyou_video'") || appSrc.includes("d.key === 'landing.thankyou_video'"), 'admin render for the video field');
    assert.ok(appSrc.includes("d.key === 'landing.thankyou_calendly_url'"), 'admin render for the calendly field');
  });

  check('calendly decision pin: no calendly script host anywhere — CTA button only, CSP untouched', () => {
    const headers = fs.readFileSync(path.join(root, 'server', 'securityHeaders.js'), 'utf8');
    assert.ok(!headers.includes('calendly'), 'global CSP gains no calendly host');
    const tySrc = fs.readFileSync(path.join(root, 'public', 'thankyou.html'), 'utf8');
    assert.ok(!tySrc.includes('assets.calendly.com'), 'page loads no calendly widget script');
  });
}

/* ===================================================================== */
/* Part C — in-process route: email on both paths + redirectUrl           */
/* ===================================================================== */

async function partC() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Thankyou Fixture', 'thankyou-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  const leadCount = () => wdb.prepare('SELECT COUNT(*) AS c FROM leads').get().c;

  const landingThankYou = require(path.join(root, 'server/landingThankYou.js'));
  const realSend = landingThankYou.sendLandingThankYou;
  const calls = [];
  let throwMode = false;
  landingThankYou.sendLandingThankYou = async (input) => {
    calls.push(input);
    if (throwMode) throw new Error('boom — mailer exploded');
    return { sent: true };
  };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/landing', require(path.join(root, 'server/routes/landing.js')));
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (body) => {
    const res = await fetch(`${base}/api/v1/landing/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  try {
    await checkAsync('route: new-lead submit → 200 + redirectUrl, thank-you helper called once for the submitter', async () => {
      const r = await post({ fullName: 'Ada Lovelace', email: 'ada@example.invalid', phone: '+1 610-555-0101' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.data.redirectUrl, '/thankyou');
      assert.equal(leadCount(), 1);
      assert.equal(calls.length, 1, 'one thank-you dispatch');
      assert.equal(calls[0].email, 'ada@example.invalid');
      assert.equal(calls[0].fullName, 'Ada Lovelace');
    });

    await checkAsync('route: duplicate-email fold submit → 200 + redirectUrl, thank-you helper called again', async () => {
      const r = await post({ fullName: 'Ada L.', email: 'ADA@example.invalid', phone: '+1 610-555-9999' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.data.redirectUrl, '/thankyou');
      assert.equal(leadCount(), 1, 'fold — still exactly one lead');
      assert.equal(calls.length, 2, 'fold path also dispatches the thank-you');
    });

    await checkAsync('route: a THROWING mailer still yields 200 + redirectUrl (submission never fails on mail)', async () => {
      throwMode = true;
      try {
        const r = await post({ fullName: 'Grace Hopper', email: 'grace@example.invalid', phone: '+1 610-555-0102' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.data.redirectUrl, '/thankyou');
        assert.equal(leadCount(), 2);
      } finally {
        throwMode = false;
      }
    });
  } finally {
    landingThankYou.sendLandingThankYou = realSend;
    await new Promise((resolve) => srv.close(resolve));
  }
}

/* ===================================================================== */
/* Part D — HTTP: /thankyou dormant → set → rendered → cleared            */
/* ===================================================================== */

async function partD() {
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

    const getText = async (p) => {
      const res = await fetch(BASE + p);
      return { status: res.status, text: await res.text() };
    };

    await checkAsync('GET /thankyou (dormant) → 200, thanks copy, no sections, no tokens, no raw settings', async () => {
      const r = await getText('/thankyou');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes("you're on the list"), 'thank-you heading');
      assert.ok(r.text.includes('hear back from us shortly'), 'promised copy');
      assert.ok(!r.text.includes('{{'), 'zero token leakage');
      assert.ok(!r.text.includes('<iframe'), 'no iframe while the video is unset');
      assert.ok(!r.text.includes('id="thankyou-video"') && !r.text.includes('id="thankyou-booking"'), 'both sections dormant');
      assert.ok(!r.text.includes('calendly.com'), 'no calendly anywhere while unset');
    });

    await checkAsync('GET /thankyou.html is intercepted the same way (no raw tokens)', async () => {
      const r = await getText('/thankyou.html');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('{{'));
    });

    await checkAsync('settings: saving a watch URL stores the bare ID; saving calendly stores the URL', async () => {
      await platform.setPlatformSetting('landing.thankyou_video', `https://www.youtube.com/watch?v=${ID_B}`);
      assert.equal(await platform.getPlatformSetting('landing.thankyou_video', ''), ID_B);
      await platform.setPlatformSetting('landing.thankyou_calendly_url', CAL_URL);
      assert.equal(await platform.getPlatformSetting('landing.thankyou_calendly_url', ''), CAL_URL);
    });

    await checkAsync('GET /thankyou (set) → youtube-nocookie iframe from the stored ID + Calendly CTA, no raw setting text', async () => {
      const r = await getText('/thankyou');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('id="thankyou-video"'), 'video section renders');
      assert.ok(r.text.includes(`https://www.youtube-nocookie.com/embed/${ID_B}`), 'iframe built from stored ID');
      assert.ok(!r.text.includes('watch?v='), 'the pasted watch URL itself is not rendered');
      assert.ok(r.text.includes('id="thankyou-booking"'), 'booking section renders');
      assert.ok(r.text.includes(`href="${CAL_URL}"`), 'CTA links to the stored Calendly URL');
      assert.ok(r.text.includes('Book your appointment'), 'CTA label');
      assert.ok(!r.text.includes('assets.calendly.com'), 'no calendly widget script (CTA-only decision)');
      assert.ok(!r.text.includes('{{'), 'zero token leakage');
    });

    await checkAsync('settings: non-YouTube video + non-Calendly URL rejected at the platform choke point, values unchanged', async () => {
      await assert.rejects(
        () => platform.setPlatformSetting('landing.thankyou_video', '<iframe src="https://player.vimeo.com/video/123"></iframe>'),
        (e) => e.code === 'VALIDATION'
      );
      await assert.rejects(
        () => platform.setPlatformSetting('landing.thankyou_calendly_url', 'https://evil.example/book'),
        (e) => e.code === 'VALIDATION'
      );
      await assert.rejects(
        () => platform.setPlatformSetting('landing.thankyou_calendly_url', 'http://calendly.com/x'),
        (e) => e.code === 'VALIDATION'
      );
      assert.equal(await platform.getPlatformSetting('landing.thankyou_video', ''), ID_B);
      assert.equal(await platform.getPlatformSetting('landing.thankyou_calendly_url', ''), CAL_URL);
    });

    await checkAsync('submit over HTTP (mail unconfigured in the fixture) still succeeds with redirectUrl', async () => {
      const res = await fetch(`${BASE}/api/v1/landing/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: 'Http Ada', email: 'http-ada@example.invalid', phone: '+1 610-555-0103' }),
      });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      assert.equal(json.data.redirectUrl, '/thankyou');
    });

    await checkAsync('settings cleared → /thankyou dormant again', async () => {
      await platform.setPlatformSetting('landing.thankyou_video', '');
      await platform.setPlatformSetting('landing.thankyou_calendly_url', '');
      const r = await getText('/thankyou');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('<iframe'));
      assert.ok(!r.text.includes('id="thankyou-video"') && !r.text.includes('id="thankyou-booking"'));
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

async function main() {
  partA();
  await partA2();
  partB();
  await partC();
  await partD();
  console.log(JSON.stringify({ batch70: true, checks: results.length, passed: true }));
  for (const name of results) console.log('  ✓ ' + name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
