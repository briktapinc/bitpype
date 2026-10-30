'use strict';
/**
 * Batch 75 — Facebook / earnings disclaimer in the footer small print
 * of the marketing pages, + /solo hosting the Solo Agency Playbook
 * (Ely, 2026-10-30).
 *
 *   Part A — the single source (server/marketingDisclaimer.js): the
 *     two paragraphs equal Ely's copy CHARACTER FOR CHARACTER (the
 *     module writes non-ASCII as \u escapes; this test writes them as
 *     literal characters — two independent representations that must
 *     agree), the injection is idempotent, unknown schemes no-op, and
 *     the templated opt-in map names exactly the four marketing pages
 *     (legal pages and solo.html are NOT in it).
 *   Part B — HTTP against the real server booted on temp DBs: every
 *     in-scope page (/, /landing, /how-it-works, /how, /website-promo,
 *     /thankyou, /onboarding) serves both disclaimer paragraphs
 *     exactly once; excluded surfaces (/portal, /app, both legal
 *     pages) serve NEITHER paragraph; existing page content pins from
 *     earlier batches still hold.
 *   Part C — /solo: 200, the playbook headline, ZERO occurrences of
 *     the demo-link placeholder, all six demo CTAs pointing at
 *     /landing?ref=solo-demo, the disclaimer pins present exactly once
 *     (from the playbook's own footer — the injection marker is
 *     absent, proving no second copy was added), and the served bytes
 *     equal the hosted file public/solo.html.
 *   Part D — solo-demo source marking (same boot, seeded ws1): the
 *     served /landing carries the hidden demo_source field wired to
 *     ?ref=solo-demo; a marked submit tags the lead 'solo-demo' and
 *     records ONE deduped landing_solo_demo_interest event on both
 *     the create and fold paths; an unmarked submit is unchanged; a
 *     bogus marker value is ignored and stored nowhere; a marked fold
 *     into a foreign lead adds only the solo tag/event and leaves
 *     source/group/category/notes untouched (Batch 68 intact).
 *
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b75-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch75', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const PORT = 31475;
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

const PINS = [
  'not a part of the Facebook™ website',
  'DO NOT PURCHASE from Bitpype',
  'sales figures stated on this page',
];
const count = (s, sub) => String(s).split(sub).length - 1;

/* ===================================================================== */
/* Part A — single source: verbatim text + injection mechanics            */
/* ===================================================================== */

function partA() {
  const md = require(path.join(root, 'server/marketingDisclaimer.js'));

  check('A: paragraphs equal Ely\u2019s copy character-for-character', () => {
    assert.deepEqual(md.DISCLAIMER_PARAGRAPHS, [
      'This site is not a part of the Facebook™ website or Facebook™ Inc. Additionally, this site is NOT endorsed by Facebook™ in any way. FACEBOOK™ is a trademark of FACEBOOK™, Inc.',
      'DISCLAIMER: The sales figures stated on this page and discussed in the training curriculum are our personal sales figures and in some cases the sales figures of previous or existing clients. Please understand these results are not typical. We’re not implying you’ll duplicate them (or do anything for that matter). The average person who buys “how to” information gets little to no results. We’re using these references for example purposes only. Your results will vary and depend on many factors including but not limited to your background, experience, and work ethic. All business entails risk as well as massive and consistent effort and action. If you’re not willing to accept that, please DO NOT PURCHASE from Bitpype.',
    ]);
  });

  check('A: disclaimerHtml carries both paragraphs + all pins, small-print styling', () => {
    const html = md.disclaimerHtml('light');
    for (const p of md.DISCLAIMER_PARAGRAPHS) assert.ok(html.includes(p), 'paragraph present verbatim');
    for (const pin of PINS) assert.equal(count(html, pin), 1, `pin once: ${pin}`);
    assert.ok(html.includes('class="bp-earnings-disclaimer"'), 'marker class');
    assert.ok(html.includes('font-size:12.5px'), 'small print');
    assert.ok(html.includes('border-top:1px solid'), 'hairline separation');
    const dark = md.disclaimerHtml('dark');
    assert.ok(dark.includes('rgba(255,250,244,.62)'), 'dark scheme uses light-muted text');
  });

  check('A: injection lands before </body>, is idempotent, unknown scheme no-ops', () => {
    const page = '<html><body><footer>x</footer></body></html>';
    const once = md.injectDisclaimer(page, 'light');
    assert.ok(once.indexOf('bp-earnings-disclaimer') > once.indexOf('</footer>'), 'block sits after the footer');
    assert.ok(once.indexOf('bp-earnings-disclaimer') < once.indexOf('</body>'), 'block sits before </body>');
    assert.equal(md.injectDisclaimer(once, 'light'), once, 'second injection is a no-op');
    assert.equal(md.injectDisclaimer(page, undefined), page, 'no scheme = no block');
    assert.equal(md.injectDisclaimer(page, 'legal'), page, 'unknown scheme = no block');
  });

  check('A: templated opt-in map is exactly the four marketing pages', () => {
    assert.deepEqual(Object.keys(md.TEMPLATED_PAGE_SCHEMES).sort(), [
      'home.html',
      'how-it-works.html',
      'how.html',
      'onboarding.html',
    ]);
    assert.equal(md.TEMPLATED_PAGE_SCHEMES['how.html'], 'dark', '/how gets the dark scheme');
    assert.ok(!('legal/terms.html' in md.TEMPLATED_PAGE_SCHEMES), 'legal terms excluded');
    assert.ok(!('legal/privacy.html' in md.TEMPLATED_PAGE_SCHEMES), 'legal privacy excluded');
    assert.ok(!('solo.html' in md.TEMPLATED_PAGE_SCHEMES), 'solo excluded — its footer already carries the text');
    assert.ok(!('landing.html' in md.TEMPLATED_PAGE_SCHEMES), 'landing goes through its dedicated sender');
    assert.ok(!('thankyou.html' in md.TEMPLATED_PAGE_SCHEMES), 'thankyou goes through its dedicated sender');
  });

  check('A: server.js wiring — senders inject, solo serves verbatim, promo route replaced', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(src.includes("require('./server/marketingDisclaimer')"), 'module required');
    assert.ok(
      src.includes('marketingDisclaimer.TEMPLATED_PAGE_SCHEMES[rel]'),
      'sendTemplatedPage injects by rel map'
    );
    assert.equal(count(src, "marketingDisclaimer.injectDisclaimer(html, 'light')"), 2, 'landing + thankyou senders inject');
    assert.ok(src.includes("app.get(['/solo', '/solo/']"), '/solo clean route');
    assert.ok(src.includes("app.get('/solo.html'"), '/solo.html intercept');
    assert.ok(src.includes("app.get('/website-promo.html'"), '/website-promo.html intercept');
  });

  check('A: hosted solo file — placeholder-free, CTAs carry the solo-demo marker, disclaimer already inside', () => {
    const solo = fs.readFileSync(path.join(root, 'public/solo.html'), 'utf8');
    assert.equal(count(solo, 'PASTE-DEMO-LINK-HERE'), 0, 'no dead placeholder ships');
    assert.equal(count(solo, 'href="/landing?ref=solo-demo"'), 6, 'all six demo CTAs point at /landing?ref=solo-demo');
    assert.equal(count(solo, 'href="/landing"'), 0, 'no unmarked CTA remains');
    for (const pin of PINS) assert.equal(count(solo, pin), 1, `solo pin once: ${pin}`);
    assert.equal(count(solo, 'bp-earnings-disclaimer'), 0, 'solo carries the text in its own footer, not the injected block');
    assert.ok(solo.includes('<title>Run a Solo Agency on BitPype'), 'playbook title');
    assert.ok(!solo.includes('{{'), 'no template tokens in the standalone document');
  });
}

/* ===================================================================== */
/* Part B + C — HTTP against the real server                              */
/* ===================================================================== */

async function partBC() {
  // Seed workspace 1 (batch58 pattern) so Part D can file real leads.
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  await db.query("INSERT INTO workspaces (id, name, slug) VALUES (1, 'Disclaimer Fixture', 'disclaimer-fixture')");
  const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
  const wdb = openWorkspaceDb(1);

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
      const res = await fetch(BASE + p, { redirect: 'manual' });
      return { status: res.status, text: await res.text() };
    };

    const IN_SCOPE = ['/', '/landing', '/how-it-works', '/how', '/website-promo', '/thankyou', '/onboarding'];
    for (const p of IN_SCOPE) {
      await checkAsync(`B: GET ${p} → 200 with both disclaimer paragraphs exactly once`, async () => {
        const r = await getText(p);
        assert.equal(r.status, 200);
        for (const pin of PINS) assert.equal(count(r.text, pin), 1, `pin exactly once on ${p}: ${pin}`);
        assert.equal(count(r.text, 'bp-earnings-disclaimer'), 1, `injected block once on ${p}`);
        assert.ok(!r.text.includes('{{'), `no token leakage on ${p}`);
      });
    }

    await checkAsync('B: in-scope pages keep their existing content (spot pins)', async () => {
      assert.ok((await getText('/')).text.includes("We'll handle the website."), 'home h1 intact');
      assert.ok((await getText('/landing')).text.includes('Start your own'), 'landing headline intact');
      assert.ok((await getText('/how')).text.includes('A desk for the'), 'how headline intact');
      assert.ok((await getText('/onboarding')).text.includes('What we need from you'), 'onboarding checklist intact');
    });

    const EXCLUDED = ['/portal', '/app', '/legal/terms.html', '/legal/privacy.html'];
    for (const p of EXCLUDED) {
      await checkAsync(`B: GET ${p} → 200 with NO disclaimer`, async () => {
        const r = await getText(p);
        assert.equal(r.status, 200);
        for (const pin of PINS) assert.equal(count(r.text, pin), 0, `pin absent on ${p}: ${pin}`);
        assert.equal(count(r.text, 'bp-earnings-disclaimer'), 0, `no block on ${p}`);
      });
    }

    await checkAsync('C: GET /solo + /solo.html → the playbook, verbatim, disclaimer once, no placeholder', async () => {
      const hosted = fs.readFileSync(path.join(root, 'public/solo.html'), 'utf8');
      for (const p of ['/solo', '/solo.html']) {
        const r = await getText(p);
        assert.equal(r.status, 200, `${p} 200`);
        assert.equal(r.text, hosted, `${p} serves the hosted file verbatim`);
        assert.ok(r.text.includes('<h1>Run a <em>solo agency</em> on BitPype</h1>'), 'playbook headline');
        assert.equal(count(r.text, 'PASTE-DEMO-LINK-HERE'), 0, 'no placeholder');
        assert.equal(count(r.text, 'href="/landing?ref=solo-demo"'), 6, 'six demo CTAs carry the solo-demo marker');
        for (const pin of PINS) assert.equal(count(r.text, pin), 1, `solo pin exactly once: ${pin}`);
        assert.equal(count(r.text, 'bp-earnings-disclaimer'), 0, 'no injected second copy');
      }
    });

    /* ---------------- Part D — solo-demo source marking --------------- */
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
    const leadRow = (id) => wdb.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    const leadTags = (id) => JSON.parse(leadRow(id).tags || '[]');
    const soloEvents = (id) =>
      wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'landing_solo_demo_interest'")
        .get(id).c;

    await checkAsync('D: served /landing carries the hidden demo_source field + ref wiring (no visible change)', async () => {
      const r = await getText('/landing');
      assert.equal(r.status, 200);
      assert.ok(r.text.includes('id="lf-demo-source"'), 'hidden field present');
      assert.ok(r.text.includes('name="demo_source"'), 'field name is demo_source');
      assert.ok(r.text.includes("get('ref') === 'solo-demo'"), 'page mirrors only the exact ref value');
      assert.ok(r.text.includes('demo_source:'), 'field is submitted with the form');
    });

    let plainId = null;
    await checkAsync('D: submit WITHOUT the marker → plain software-interest lead, no solo mark anywhere', async () => {
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Plain Prospect',
        email: 'plain@example.invalid',
        phone: '610-555-0111',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.redirectUrl, '/thankyou', 'redirect unchanged');
      plainId = r.json.data.id;
      assert.ok(!leadTags(plainId).includes('solo-demo'), 'no solo tag');
      assert.equal(soloEvents(plainId), 0, 'no solo event');
      assert.ok(!String(leadRow(plainId).notes || '').includes('Solo Agency'), 'no solo note');
    });

    let soloId = null;
    await checkAsync('D: submit WITH demo_source=solo-demo → tag + one solo event + note line; response unchanged', async () => {
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Solo Prospect',
        email: 'solo@example.invalid',
        phone: '610-555-0122',
        demo_source: 'solo-demo',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.redirectUrl, '/thankyou', 'redirect unchanged');
      soloId = r.json.data.id;
      const tags = leadTags(soloId);
      assert.ok(tags.includes('landing-software') && tags.includes('software-interest'), 'standard tags intact');
      assert.equal(tags.filter((t) => t === 'solo-demo').length, 1, 'solo-demo tag exactly once');
      assert.equal(soloEvents(soloId), 1, 'exactly one solo event');
      const ev = wdb
        .prepare("SELECT detail FROM lead_events WHERE lead_id = ? AND type = 'landing_solo_demo_interest'")
        .get(soloId);
      assert.ok(ev.detail.includes('Solo Agency playbook'), 'event names the solo source');
      assert.ok(String(leadRow(soloId).notes || '').includes('Solo Agency playbook demo CTA'), 'note line recorded');
    });

    await checkAsync('D: submit with a BOGUS marker → ignored, succeeds, raw value stored nowhere', async () => {
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Bogus Prospect',
        email: 'bogus@example.invalid',
        phone: '610-555-0133',
        demo_source: 'evil-marker-zzz',
      });
      assert.equal(r.status, 200, r.text);
      const id = r.json.data.id;
      assert.ok(!leadTags(id).includes('solo-demo'), 'no solo tag from a bogus value');
      assert.equal(soloEvents(id), 0, 'no solo event');
      assert.ok(!JSON.stringify(leadRow(id)).includes('evil-marker-zzz'), 'bogus value not stored on the lead');
      const evs = wdb.prepare('SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND detail LIKE ?').get(id, '%evil-marker-zzz%');
      assert.equal(evs.c, 0, 'bogus value not stored in events');
    });

    await checkAsync('D: fold WITH marker (repeat submits) → same lead, tag once, event stays exactly one', async () => {
      for (const em of ['SOLO@example.invalid', 'solo@example.invalid']) {
        const r = await post('/api/v1/landing/submit', {
          fullName: 'Solo Prospect',
          email: em,
          phone: '610-555-0122',
          demo_source: 'solo-demo',
        });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.data.id, soloId, 'folds into the same lead');
      }
      assert.equal(leadTags(soloId).filter((t) => t === 'solo-demo').length, 1, 'tag never stacks');
      assert.equal(soloEvents(soloId), 1, 'event deduped across repeat folds');
    });

    await checkAsync('D: fold into a FOREIGN lead with marker → solo tag + event land; Batch 68 protections intact', async () => {
      const info = wdb
        .prepare(
          "INSERT INTO leads (business_name, email, category, lead_group, source, tags, phone, notes) VALUES ('Foreign Plumbing LLC', 'foreign@example.invalid', '', '', 'manual', '[]', '', '')"
        )
        .run();
      const foreignId = Number(info.lastInsertRowid);
      const r = await post('/api/v1/landing/submit', {
        fullName: 'Foreign Owner',
        email: 'foreign@example.invalid',
        phone: '610-555-0144',
        demo_source: 'solo-demo',
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.id, foreignId, 'folded into the foreign lead');
      const row = leadRow(foreignId);
      assert.equal(row.source, 'manual', 'source untouched — deploy eligibility cannot change');
      assert.equal(row.lead_group, '', 'lead_group untouched');
      assert.equal(row.category, '', 'category untouched');
      assert.equal(row.notes, '', 'notes untouched (foreign fold stays event-only for standard fields)');
      assert.deepEqual(JSON.parse(row.tags || '[]'), ['solo-demo'], 'ONLY the solo-demo tag was added');
      assert.equal(soloEvents(foreignId), 1, 'solo event recorded for staff visibility');
      const std = wdb
        .prepare("SELECT COUNT(*) AS c FROM lead_events WHERE lead_id = ? AND type = 'landing_software_interest'")
        .get(foreignId);
      assert.equal(std.c, 1, 'standard interest event still recorded (Batch 58/68 behavior)');
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}

/* ===================================================================== */

async function main() {
  partA();
  await partBC();
  console.log(JSON.stringify({ file: 'batch75-disclaimer-regressions', passed: true, checks: results.length }));
  for (const name of results) console.log('  ok -', name);
}

main().catch((e) => {
  console.error(JSON.stringify({ file: 'batch75-disclaimer-regressions', passed: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
