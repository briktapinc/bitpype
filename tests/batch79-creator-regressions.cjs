'use strict';
/**
 * Batch 79 — /creator: the Solo license pitched to content creators.
 *
 * What shipped:
 *   - GET /creator (+ /creator.html) — a templated marketing page in
 *     the /landing shell (Batch 56 tokens substituted at serve time;
 *     the Batch 75 marketing disclaimer injected by its dedicated
 *     sender — the page carries clearly-labeled EXAMPLE math about
 *     earnings and must never present it as a promise).
 *   - An application form (full name, email, main platform, follower
 *     range, niche, about-your-audience, optional phone) posting to
 *     POST /api/v1/creator/submit: same armor as /landing (shared
 *     per-IP rate limiter 20/15 min + Turnstile) and a lead created
 *     through the lead engine in ws1, marked source 'creator-solo'
 *     (source_ref 'creator', group/category 'Creator Solo', tag
 *     'creator-solo'), qualifier answers in the lead notes.
 *   - One email = one lead: a repeat application folds (Batch 68
 *     rule — marker fold only for leads /creator created; a fold
 *     into a foreign lead records a creator_solo_application event
 *     ONLY).
 *   - Deploy eligibility: hostingerDeploy.isSoftwareInterestLead
 *     keys off source === 'landing-software' only, so a creator-solo
 *     lead is never deploy-eligible (asserted directly below).
 *   - ONE cross-link on /solo pointing creators at /creator.
 *
 * Harness: unit checks + HTTP tests against the real server booted on
 * temp platform/workspace DBs (batch58 pattern). No live server, no
 * real leads. Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b79-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch79', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString('base64');

const PORT = 31479;
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

const VALID = {
  fullName: 'Casey Creator',
  email: 'casey@example.invalid',
  platform: 'youtube',
  followerRange: '50k-250k',
  niche: 'Home fitness coaching',
  audience: 'Mostly women 25-44 starting home gyms; many ask about starting their own coaching businesses.',
  phone: '+1 610-555-0139',
};

/* ===================================================================== */
/* Part A — static / unit checks                                          */
/* ===================================================================== */

function partA() {
  check('page: creator.html carries the opportunity math, the visible disclaimer and every form field', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'creator.html'), 'utf8');
    assert.ok(html.includes('{{PUBLIC_URL}}'), 'public URL token');
    assert.ok(html.includes('{{SUPPORT_EMAIL}}'), 'support email token');
    // The opportunity examples, exactly as approved:
    assert.ok(html.includes('25,000 followers') && html.includes('$24,750'), '25K scenario');
    assert.ok(html.includes('100,000 followers') && html.includes('$99,000'), '100K scenario');
    assert.ok(html.includes('500,000 followers') && html.includes('$247,500'), '500K scenario');
    assert.ok(html.includes('$1,999'), 'Solo license price');
    assert.ok(html.includes('Example math — not an earnings promise'), 'example-math disclaimer, visible in the section');
    assert.ok(html.includes('BitPype does not guarantee customers, revenue or income'), 'no-guarantee sentence');
    // Form fields:
    for (const f of ['name="fullName"', 'name="email"', 'name="platform"', 'name="followerRange"', 'name="niche"', 'name="audience"', 'name="phone"']) {
      assert.ok(html.includes(f), `field ${f}`);
    }
    assert.ok(html.includes('/api/v1/creator/submit'), 'posts to the creator route');
    assert.ok(html.includes('/js/captcha.js'), 'shared Turnstile helper');
    assert.ok(html.includes('id="creator-form"'), 'application form');
    // No terms beyond the approved offer:
    assert.ok(!/setup fee|money-back|guarantee of income/i.test(html.replace('does not guarantee', '')), 'no unapproved terms');
  });

  check('wiring: server.js mounts the creator API + page sender', () => {
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes("require('./server/routes/creator')"), 'route module required');
    assert.ok(serverSrc.includes("app.use('/api/v1/creator', creatorRoutes)"), 'API mounted');
    assert.ok(serverSrc.includes("app.get(['/creator', '/creator/']"), 'page route');
    assert.ok(serverSrc.includes('sendCreatorPage'), 'dedicated sender');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'creator.js'), 'utf8');
    assert.ok(routeSrc.includes("source: 'creator-solo'"), 'lead marker');
    assert.ok(routeSrc.includes('requireCaptcha') && routeSrc.includes('rateLimit'), 'captcha + limiter armor');
    assert.ok(routeSrc.includes('creator_solo_application'), 'fold event type');
  });

  check('solo cross-link: exactly one /creator link on /solo', () => {
    const solo = fs.readFileSync(path.join(root, 'public', 'solo.html'), 'utf8');
    const hits = solo.split('href="/creator"').length - 1;
    assert.equal(hits, 1, `expected exactly 1 creator link, found ${hits}`);
  });

  check('deploy eligibility: a creator-solo lead is NOT deploy-eligible (Batch 68 rule)', () => {
    const hd = require(path.join(root, 'server', 'hostingerDeploy.js'));
    assert.equal(typeof hd.isSoftwareInterestLead, 'function', 'eligibility helper exported');
    assert.equal(hd.isSoftwareInterestLead({ source: 'creator-solo', lead_group: 'Creator Solo', tags: ['creator-solo'] }), false);
    assert.equal(hd.isSoftwareInterestLead({ source: 'landing-software' }), true, 'sanity: the real marker still qualifies');
  });
}

/* ===================================================================== */
/* Part B — HTTP: page, form, fold, armor                                 */
/* ===================================================================== */

async function partB() {
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Creator Fixture', 'creator-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);
  const leadCount = () => wdb.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  const leadByEmail = (email) => wdb.prepare('SELECT * FROM leads WHERE email = ?').get(email);

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

    await checkAsync('GET /creator → 200 with the opportunity section, the example-math disclaimer and no token leakage', async () => {
      const r = await getText('/creator');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('You built the audience'), 'hero present');
      assert.ok(r.text.includes('The opportunity, in plain numbers'), 'opportunity section present');
      assert.ok(r.text.includes('Example math — not an earnings promise'), 'disclaimer present in served page');
      assert.ok(r.text.includes('$1,999'), 'license price present');
      assert.ok(r.text.includes('bp-earnings-disclaimer'), 'Batch 75 footer disclaimer injected');
      assert.ok(!r.text.includes('{{'), 'zero token leakage');
    });

    await checkAsync('GET /creator.html is intercepted the same way (no raw tokens)', async () => {
      const r = await getText('/creator.html');
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('{{'));
      assert.ok(r.text.includes('Example math — not an earnings promise'));
    });

    await checkAsync('GET /solo → 200 and carries the creator cross-link', async () => {
      const r = await getText('/solo');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('href="/creator"'), 'creator link present');
    });

    await checkAsync('validation matrix: missing/garbage fields → coded 400, nothing written', async () => {
      const cases = [
        { ...VALID, fullName: '' },
        { ...VALID, email: 'not-an-email' },
        { ...VALID, email: '' },
        { ...VALID, platform: 'myspace' },
        { ...VALID, platform: '' },
        { ...VALID, followerRange: 'millions' },
        { ...VALID, niche: '' },
        { ...VALID, audience: '' },
        { ...VALID, phone: 'call me maybe' },
        {},
      ];
      for (const body of cases) {
        const r = await post('/api/v1/creator/submit', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json.code, 'VALIDATION');
        assert.equal(r.json.ok, false);
      }
      assert.equal(leadCount(), 0, 'no lead written by invalid submissions');
    });

    let leadId = null;
    await checkAsync('valid application creates exactly ONE ws1 lead with the creator-solo marker + qualifier notes', async () => {
      const r = await post('/api/v1/creator/submit', VALID);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      leadId = r.json.data.id;
      assert.ok(Number.isInteger(leadId) && leadId > 0);
      assert.equal(leadCount(), 1);
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      assert.equal(row.business_name, 'Casey Creator');
      assert.equal(row.email, VALID.email);
      assert.equal(row.phone, VALID.phone);
      assert.equal(row.source, 'creator-solo');
      assert.equal(row.source_ref, 'creator');
      assert.equal(row.lead_group, 'Creator Solo');
      // The lead engine canonicalizes category casing on write.
      assert.equal(row.category, 'Creator Solo');
      const tags = JSON.parse(row.tags || '[]');
      assert.ok(tags.includes('creator-solo'), 'creator-solo tag');
      assert.ok(row.notes.includes('Applied for the BitPype Solo license (creator path)'), 'application note');
      assert.ok(row.notes.includes('Platform: YouTube'), 'platform in notes');
      assert.ok(row.notes.includes('Followers: 50,000 – 250,000'), 'follower range in notes');
      assert.ok(row.notes.includes('Niche: Home fitness coaching'), 'niche in notes');
      assert.ok(row.notes.includes('About their audience:'), 'audience answer in notes');
    });

    await checkAsync('repeat application with the same email folds — no second lead, polite success, event recorded', async () => {
      const r = await post('/api/v1/creator/submit', { ...VALID, phone: '+1 215-555-0177' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.id, leadId, 'same lead id returned');
      assert.equal(leadCount(), 1, 'still exactly one lead');
      const row = wdb.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      assert.equal(row.phone, VALID.phone, 'existing phone not overwritten by the fold');
      const ev = wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'creator_solo_application'")
        .get(leadId);
      assert.equal(ev.c, 1, 'application event recorded on the folded lead');
    });

    await checkAsync('fold into a FOREIGN lead: event only — source, tags, group untouched, still not deploy-eligible', async () => {
      const foreign = await post('/api/v1/landing/submit', {
        fullName: 'Frank Foreign',
        email: 'frank@example.invalid',
        phone: '+1 610-555-0111',
      });
      assert.equal(foreign.status, 200, foreign.text);
      const before = leadByEmail('frank@example.invalid');
      assert.equal(before.source, 'landing-software');

      // A creator application naming the same email folds into Frank's
      // lead. It must NOT become a creator-solo lead — and the reverse
      // check matters too: nothing about the creator path may alter
      // any lead's markers.
      const r = await post('/api/v1/creator/submit', { ...VALID, email: 'frank@example.invalid', fullName: 'Frank Foreign' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.id, before.id);
      assert.equal(leadCount(), 2, 'no new lead created by the fold');
      const after = leadByEmail('frank@example.invalid');
      assert.equal(after.source, 'landing-software', 'source untouched');
      assert.equal(after.lead_group, before.lead_group, 'group untouched');
      assert.equal(after.tags, before.tags, 'tags untouched — no creator-solo union');
      const ev = wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'creator_solo_application'")
        .get(before.id);
      assert.equal(ev.c, 1, 'the application is still visible as an event');
    });

    await checkAsync('phone is optional: an application without one still lands', async () => {
      const { phone, ...noPhone } = VALID;
      const r = await post('/api/v1/creator/submit', { ...noPhone, email: 'nophone@example.invalid' });
      assert.equal(r.status, 200, r.text);
      const row = leadByEmail('nophone@example.invalid');
      assert.ok(row, 'lead created');
      assert.equal(row.source, 'creator-solo');
    });

    await checkAsync('registration stays closed (live posture) while the form works', async () => {
      await require('./lib/platformTestDb.cjs').setPlatformSetting(db, 'registration.open', '0');
      const r = await post('/api/v1/auth/register', {
        name: 'Nope',
        email: 'nope@example.invalid',
        password: 'whatever-123',
      });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.json.error, 'REGISTRATION_DISABLED');
    });

    await checkAsync('rate limit: the shared 20/15min per-IP limiter eventually answers 429', async () => {
      // Prior submits in this boot already consumed part of the
      // bucket; burst with fresh emails until the limiter speaks.
      let saw429 = false;
      for (let i = 0; i < 30 && !saw429; i++) {
        const r = await post('/api/v1/creator/submit', {
          ...VALID,
          email: `burst${i}@example.invalid`,
          fullName: `Burst ${i}`,
        });
        if (r.status === 429) saw429 = true;
        else assert.equal(r.status, 200, `burst ${i}: ${r.text}`);
      }
      assert.ok(saw429, 'limiter never fired within 30 burst submissions');
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

(async () => {
  partA();
  await partB();
  console.log(JSON.stringify({ file: 'batch79-creator-regressions', checks: results.length, passed: true }));
  console.log(results.map((r) => `ok - ${r}`).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
