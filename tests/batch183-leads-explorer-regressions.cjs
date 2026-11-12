'use strict';
/**
 * Batch 183 — Leads Explorer (real-data map on the staff Leads page).
 *
 * What this pins:
 *   - Workspace isolation: explorerData over workspace 2's DB sees
 *     ZERO workspace-1 leads (leads live in per-workspace DBs; the
 *     explorer reads only the handle it is handed).
 *   - Band thresholds come from workspace settings
 *     (score.threshold_hot / score.threshold_qualified), not constants.
 *   - Radius math: pins are filtered by haversine distance from the
 *     area centre (centroid of ALL resolved pins in the area).
 *   - Match acceptance: a Places Text Search candidate is accepted
 *     ONLY on normalized-name equality AND locality == lead city.
 *     City mismatch or name mismatch → cache 'no_match', the lead
 *     lands in unmapped, its lat/lng stay untouched.
 *   - Cache behaviour: a second explorerData call makes ZERO Places
 *     fetch calls (accepted leads carry stored coords; no_match is
 *     cached, not retried).
 *   - No-key dormant: apiKey '' → dormant:true, zero fetch calls,
 *     pins [], every area lead unmapped with why 'no_key'.
 *   - Reasons: latest lead_scores.breakdown mapped to plain labels;
 *     with no breakdown row, facts-derived only.
 *   - HTTP: the real server answers GET /leads/explorer (200 + shape,
 *     radius validated to 3|5|10) and the Places API key value NEVER
 *     appears in the response body.
 *   - UI statics: the explorer mount + dormant copy in app.js, the
 *     api client method, the .explorer-* styles.
 *
 * Places is stubbed through fetchImpl injection everywhere — no live
 * Places calls. Harness: temp on-disk workspaces (DB_DRIVER=sqlite
 * locally, the gate's MySQL leg via REGRESSION_DB_DRIVER for the
 * platform DB), engine driven directly + one real server boot.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b183-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch183', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 17).toString('base64');

const PORT = 39183;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_URL = 'https://bitpype.test';
const PLACES_KEY = ['places', 'fixture', 'key', '183'].join('-');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log('  ok -', name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
  console.log('  ok -', name);
}

const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
const domain = require(path.join(root, 'server/domain.js'));
const leadEngine = require(path.join(root, 'src/leadEngine.js'));
const platform = require(path.join(root, 'server/platform.js'));

const db1 = openWorkspaceDb(1);
const db2 = openWorkspaceDb(2);
const db3 = openWorkspaceDb(3);

function mkLead(db, fields) {
  return leadEngine.createLead(db, fields).id;
}
function setCoords(db, id, lat, lng) {
  db.prepare('UPDATE leads SET latitude = ?, longitude = ? WHERE id = ?').run(lat, lng, id);
}
function setScore(db, id, score) {
  db.prepare('UPDATE leads SET score = ? WHERE id = ?').run(score, id);
}
function candidate(name, locality, lat, lng) {
  return {
    id: 'place-' + leadEngine.normalizeName(name),
    displayName: { text: name },
    formattedAddress: `1 Main St, ${locality}, PA 19601`,
    location: { latitude: lat, longitude: lng },
    addressComponents: [{ longText: locality, shortText: locality, types: ['locality', 'political'] }],
  };
}
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const query = JSON.parse(opts.body).textQuery;
    return { ok: true, status: 200, json: async () => ({ places: handler(query) }) };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  /* ---------------- A: workspace isolation ---------------- */
  const iso1 = mkLead(db1, { business_name: 'Iso One', city: 'Reading', state: 'PA' });
  setCoords(db1, iso1, 40.335, -75.927);
  mkLead(db1, { business_name: 'Iso Two', city: 'Reading', state: 'PA' });
  const isoOther = mkLead(db2, { business_name: 'Other Workspace Biz', city: 'Reading', state: 'PA' });
  setCoords(db2, isoOther, 40.34, -75.92);

  await checkAsync('A isolation: ws2 explorer sees only ws2 leads', async () => {
    const data = await leadEngine.explorerData(db2, { apiKey: '' });
    assert.deepEqual(data.areas, [{ city: 'Reading', count: 1 }]);
    assert.deepEqual(
      data.pins.map((p) => p.business_name),
      ['Other Workspace Biz']
    );
    assert.equal(data.unmapped.length, 0);
    assert.equal(data.summary.total, 1);
  });
  await checkAsync('A isolation: ws1 explorer contains no ws2 leads', async () => {
    // Lead ids are per-workspace AUTOINCREMENT, so isolation is
    // asserted on names/counts, not raw ids.
    const data = await leadEngine.explorerData(db1, { apiKey: '' });
    const names = [...data.pins.map((p) => p.business_name), ...data.unmapped.map((u) => u.business_name)];
    assert.ok(!names.includes('Other Workspace Biz'), 'ws2 lead leaked into ws1 explorer');
    assert.ok(names.includes('Iso One'));
    assert.equal(data.summary.total, 2, 'ws1 Reading area holds exactly its own two leads');
    void isoOther;
    void iso1;
  });

  /* ---------------- B: thresholds from settings ---------------- */
  const thHot = mkLead(db1, { business_name: 'Threshold Hot', city: 'Thresholdton' });
  const thWarm = mkLead(db1, { business_name: 'Threshold Warm', city: 'Thresholdton' });
  const thCool = mkLead(db1, { business_name: 'Threshold Cool', city: 'Thresholdton' });
  setCoords(db1, thHot, 40.335, -75.927);
  setCoords(db1, thWarm, 40.336, -75.926);
  setCoords(db1, thCool, 40.337, -75.925);
  setScore(db1, thHot, 95);
  setScore(db1, thWarm, 85);
  setScore(db1, thCool, 60);
  domain.setSetting(db1, 'score.threshold_hot', '90');
  domain.setSetting(db1, 'score.threshold_qualified', '80');
  await checkAsync('B thresholds: bands honour workspace settings (90/80)', async () => {
    const data = await leadEngine.explorerData(db1, { area: 'Thresholdton', apiKey: '' });
    assert.deepEqual(data.thresholds, { hot: 90, qualified: 80 });
    const bandOf = (id) => data.pins.find((p) => p.id === id).band;
    assert.equal(bandOf(thHot), 'hot');
    assert.equal(bandOf(thWarm), 'warm', 'score 85 is warm at hot=90 (would be hot at the 70 default)');
    assert.equal(bandOf(thCool), 'cool', 'score 60 is cool at qualified=80 (would be warm at the 50 default)');
    assert.deepEqual(data.summary.byBand, { hot: 1, warm: 1, cool: 1, none: 0 });
  });
  domain.setSetting(db1, 'score.threshold_hot', '70');
  domain.setSetting(db1, 'score.threshold_qualified', '50');

  /* ---------------- C: radius math ---------------- */
  const rNear1 = mkLead(db1, { business_name: 'Radius Near One', city: 'Radiustown' });
  const rNear2 = mkLead(db1, { business_name: 'Radius Near Two', city: 'Radiustown' });
  const rFar = mkLead(db1, { business_name: 'Radius Far', city: 'Radiustown' });
  setCoords(db1, rNear1, 40.335, -75.927);
  setCoords(db1, rNear2, 40.34, -75.92);
  setCoords(db1, rFar, 40.42, -75.92);
  setScore(db1, rNear1, 80);
  setScore(db1, rNear2, 60);
  setScore(db1, rFar, 80);
  await checkAsync('C radius: 3mi excludes the far pin, 10mi includes it; summary follows', async () => {
    const d3 = await leadEngine.explorerData(db1, { area: 'Radiustown', radius: 3, apiKey: '' });
    assert.ok(d3.centre, 'centre is the centroid of all resolved pins');
    assert.deepEqual(d3.pins.map((p) => p.id).sort(), [rNear1, rNear2].sort());
    assert.equal(d3.summary.withinRadius, 2);
    assert.equal(d3.summary.mapped, 3, 'mapped counts all resolved pins in the area, before the radius filter');
    assert.deepEqual(d3.summary.byBand, { hot: 1, warm: 1, cool: 0, none: 0 });
    const d10 = await leadEngine.explorerData(db1, { area: 'Radiustown', radius: 10, apiKey: '' });
    assert.equal(d10.pins.length, 3);
    assert.deepEqual(d10.summary.byBand, { hot: 2, warm: 1, cool: 0, none: 0 });
    const dBad = await leadEngine.explorerData(db1, { area: 'Radiustown', radius: 7, apiKey: '' });
    assert.equal(dBad.radius, 10, 'a radius outside 3|5|10 falls back to 10');
  });

  /* ---------------- D: match acceptance ---------------- */
  const mExact = mkLead(db1, { business_name: 'Exact Biz', city: 'Matchville', state: 'PA' });
  const mCity = mkLead(db1, { business_name: 'City Mismatch Biz', city: 'Matchville', state: 'PA' });
  const mName = mkLead(db1, { business_name: 'Name Mismatch Biz', city: 'Matchville', state: 'PA' });
  const matchFetch = stubFetch((query) => {
    if (query.includes('Exact Biz')) return [candidate('Exact Biz', 'Matchville', 40.1, -75.1)];
    if (query.includes('City Mismatch Biz')) return [candidate('City Mismatch Biz', 'Elsewhere', 40.2, -75.2)];
    if (query.includes('Name Mismatch Biz')) return [candidate('Totally Different', 'Matchville', 40.3, -75.3)];
    return [];
  });
  await checkAsync('D acceptance: exact name+city accepted, cache ok, lead coords written back', async () => {
    const data = await leadEngine.explorerData(db1, { area: 'Matchville', apiKey: PLACES_KEY, fetchImpl: matchFetch });
    const pin = data.pins.find((p) => p.id === mExact);
    assert.ok(pin, 'the accepted lead is pinned');
    assert.equal(pin.lat, 40.1);
    assert.equal(pin.lng, -75.1);
    const row = db1.prepare('SELECT latitude, longitude FROM leads WHERE id = ?').get(mExact);
    assert.equal(row.latitude, 40.1, 'resolved latitude written back onto the lead');
    assert.equal(row.longitude, -75.1);
    const cache = db1.prepare('SELECT * FROM lead_geo_cache WHERE lead_id = ?').get(mExact);
    assert.equal(cache.status, 'ok');
    assert.equal(cache.place_id, 'place-exactbiz');
    assert.ok(matchFetch.calls.length >= 1, 'the stub was consulted');
    for (const c of matchFetch.calls) {
      assert.equal(c.url, 'https://places.googleapis.com/v1/places:searchText');
      assert.equal(c.opts.headers['X-Goog-Api-Key'], PLACES_KEY, 'key travels in the header only');
      assert.ok(!c.url.includes(PLACES_KEY) && !String(c.opts.body).includes(PLACES_KEY), 'key never in URL/body');
    }
  });
  await checkAsync('D acceptance: city mismatch → no_match, unmapped, coords untouched', async () => {
    const data = await leadEngine.explorerData(db1, { area: 'Matchville', apiKey: PLACES_KEY, fetchImpl: matchFetch });
    const u = data.unmapped.find((x) => x.id === mCity);
    assert.ok(u, 'city-mismatched lead is unmapped');
    assert.equal(u.why, 'no_match');
    const row = db1.prepare('SELECT latitude, longitude FROM leads WHERE id = ?').get(mCity);
    assert.equal(row.latitude, null);
    assert.equal(row.longitude, null);
    assert.equal(db1.prepare('SELECT status FROM lead_geo_cache WHERE lead_id = ?').get(mCity).status, 'no_match');
  });
  await checkAsync('D acceptance: totally different name → no_match', async () => {
    const data = await leadEngine.explorerData(db1, { area: 'Matchville', apiKey: PLACES_KEY, fetchImpl: matchFetch });
    const u = data.unmapped.find((x) => x.id === mName);
    assert.ok(u, 'name-mismatched lead is unmapped');
    assert.equal(u.why, 'no_match');
    assert.equal(db1.prepare('SELECT latitude FROM leads WHERE id = ?').get(mName).latitude, null);
  });

  /* ---------------- E: cache behaviour ---------------- */
  await checkAsync('E cache: a repeat explorer call makes ZERO Places fetch calls', async () => {
    const before = matchFetch.calls.length;
    assert.ok(before > 0, 'the first pass did call Places');
    const again = stubFetch(() => [candidate('Exact Biz', 'Matchville', 40.1, -75.1)]);
    const data = await leadEngine.explorerData(db1, { area: 'Matchville', apiKey: PLACES_KEY, fetchImpl: again });
    assert.equal(again.calls.length, 0, 'second load is cache/stored-only — no API burn');
    assert.ok(
      data.pins.some((p) => p.id === mExact),
      'the accepted pin survives from stored coords'
    );
    assert.equal(data.unmapped.length, 2, 'both no_match leads stay unmapped from cache');
  });

  /* ---------------- F: no-key dormant ---------------- */
  const dOne = mkLead(db3, { business_name: 'Dormant One', city: 'Dormantville' });
  const dTwo = mkLead(db3, { business_name: 'Dormant Two', city: 'Dormantville' });
  await checkAsync('F dormant: no key → dormant, zero fetch, pins [], all unmapped no_key', async () => {
    const counting = stubFetch(() => [candidate('Dormant One', 'Dormantville', 40.1, -75.1)]);
    const data = await leadEngine.explorerData(db3, { apiKey: '', fetchImpl: counting });
    assert.equal(data.dormant, true);
    assert.equal(counting.calls.length, 0, 'dormant makes ZERO fetch calls');
    assert.deepEqual(data.pins, []);
    assert.equal(data.centre, null);
    assert.equal(data.unmapped.length, 2);
    assert.ok(data.unmapped.every((u) => u.why === 'no_key'));
    assert.deepEqual(data.unmapped.map((u) => u.id).sort(), [dOne, dTwo].sort());
    const cacheRows = db3.prepare('SELECT COUNT(*) AS n FROM lead_geo_cache').get().n;
    assert.equal(cacheRows, 0, 'dormant writes nothing');
  });

  /* ---------------- G: reasons ---------------- */
  const gBreak = mkLead(db1, { business_name: 'Breakdown Biz', city: 'Reasonville' });
  setCoords(db1, gBreak, 40.335, -75.927);
  db1
    .prepare('INSERT INTO lead_scores (lead_id, score, breakdown) VALUES (?, ?, ?)')
    .run(gBreak, 45, JSON.stringify({ no_website: 30, many_reviews: 15 }));
  const gFacts = mkLead(db1, { business_name: 'Facts Biz', city: 'Reasonville' });
  setCoords(db1, gFacts, 40.336, -75.926);
  db1
    .prepare('UPDATE leads SET website = ?, rating = ?, review_count = ?, phone = ? WHERE id = ?')
    .run('', 4.5, 25, '6105550100', gFacts);
  await checkAsync('G reasons: breakdown labels/points, else facts-derived only', async () => {
    const data = await leadEngine.explorerData(db1, { area: 'Reasonville', apiKey: '' });
    const pBreak = data.pins.find((p) => p.id === gBreak);
    assert.deepEqual(pBreak.reasons, [
      { label: 'No website', points: 30 },
      { label: '20+ reviews', points: 15 },
    ]);
    const pFacts = data.pins.find((p) => p.id === gFacts);
    assert.deepEqual(
      pFacts.reasons.map((r) => r.label).sort(),
      ['20+ reviews', 'No website', 'Phone listed', 'Rated over 4.0'].sort()
    );
    assert.equal(pFacts.website_state, 'No website');
  });

  /* ---------------- I: UI statics ---------------- */
  check('I ui: explorer mount, dormant copy, api method, Leaflet pin, styles', () => {
    const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.ok(appJs.includes('id="l-explorer"'), 'explorer section mounts above the chips');
    assert.ok(appJs.includes('Leads Explorer'), 'explorer heading present');
    assert.ok(appJs.includes('waiting on the Google Places API key'), 'dormant copy names the missing key honestly');
    assert.ok(appJs.includes('all waiting to be located'), 'dormant copy carries the waiting count line');
    assert.ok(appJs.includes('leaflet@1.9.4'), 'Leaflet 1.9.4 pinned');
    assert.ok(appJs.includes('sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='), 'Leaflet JS SRI hash present');
    assert.ok(appJs.includes('Locate more'), 'Locate more affordance present');
    const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    assert.ok(apiJs.includes("leadExplorer: (q) => get('/leads/explorer', q)"), 'api client method next to leadFacets');
    const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
    for (const cls of [
      '.explorer-map',
      '.explorer-pin-hot',
      '.explorer-pin-warm',
      '.explorer-pin-cool',
      '.explorer-dormant',
      '.explorer-unmapped',
    ]) {
      assert.ok(css.includes(cls), `styles carry ${cls}`);
    }
  });

  /* ---------------- H: HTTP over the real server ---------------- */
  await httpChecks();

  console.log(`batch183-leads-explorer-regressions: ${results.length} checks passed`);
}

async function httpChecks() {
  const bcrypt = require('bcryptjs');
  const db = require(path.join(root, 'server/db.js'));
  await db.migrate();
  const q = (sql, params) => db.query(sql, params);
  await q("INSERT INTO workspaces (id, name, slug) VALUES (1, 'B183 One', 'b183-one')");
  await q("INSERT INTO workspaces (id, name, slug) VALUES (2, 'B183 Two', 'b183-two')");
  const hash = (pw) => bcrypt.hashSync(pw, 12);
  await q('INSERT INTO users (email, password_hash, name, is_super_admin, status) VALUES (:e, :h, :n, 0, :s)', {
    e: 'owner183@example.invalid',
    h: hash('OwnerPass183!'),
    n: 'Owner One',
    s: 'active',
  });
  const [u1] = await q('SELECT id FROM users WHERE email = :e', { e: 'owner183@example.invalid' });
  await q('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (:w, :u, :r)', {
    w: 1,
    u: u1.id,
    r: 'owner',
  });

  await platform.setPlatformSetting('google.places_api_key', PLACES_KEY);
  await platform.setPlatformSetting('general.public_url', APP_URL);

  const httpLead = domain.leadsCreate(1, { business_name: 'HTTP Explorer Biz', city: 'Httpville', state: 'PA' }).id;
  setCoords(db1, httpLead, 40.335, -75.927);

  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
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

    function makeJar() {
      const cookies = new Map();
      return {
        async fetch(url, opts = {}) {
          const headers = { 'x-forwarded-proto': 'https', ...(opts.headers || {}) };
          if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
          if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
          const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
          const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
          for (const c of set) {
            const pair = String(c).split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
          }
          return res;
        },
      };
    }
    const totp = require(path.join(root, 'src/totp.js'));
    const jarSecrets = new Map();
    async function loginFull(jar, email, password) {
      const first = await jar.fetch(BASE + '/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const body = await first
        .clone()
        .json()
        .catch(() => null);
      if (body && body.data && body.data.mfaRequired) {
        const post = (p, b) => jar.fetch(BASE + p, { method: 'POST', body: JSON.stringify(b || {}) });
        if (body.data.mfaStage === 'enroll') {
          const start = await (await post('/api/v1/auth/mfa/enroll/start', {})).json();
          jarSecrets.set(email, start.data.secret);
          await post('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(start.data.secret) });
        } else {
          await post('/api/v1/auth/mfa/verify', { code: totp.totp(jarSecrets.get(email)) });
        }
      }
      return first.status;
    }

    await checkAsync('H http: anonymous explorer → 401', async () => {
      const res = await fetch(`${BASE}/api/v1/leads/explorer`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(res.status, 401);
    });

    const jar = makeJar();
    await checkAsync('H http: explorer 200 + shape, radius validated, key never in the body', async () => {
      const status = await loginFull(jar, 'owner183@example.invalid', 'OwnerPass183!');
      assert.equal(status, 200);
      const res = await jar.fetch(BASE + '/api/v1/leads/explorer?area=Httpville&radius=10', {
        headers: { 'x-workspace-id': '1' },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(PLACES_KEY), 'the Places API key must never reach the client payload');
      const body = JSON.parse(text);
      assert.equal(body.data.area, 'Httpville');
      assert.equal(body.data.dormant, false, 'a configured key means the explorer is live');
      assert.ok(
        body.data.pins.some((p) => p.id === httpLead),
        'the stored-coords lead is pinned'
      );
      assert.ok(Array.isArray(body.data.areas) && Array.isArray(body.data.unmapped));
      const bad = await jar.fetch(BASE + '/api/v1/leads/explorer?area=Httpville&radius=7', {
        headers: { 'x-workspace-id': '1' },
      });
      const badBody = JSON.parse(await bad.text());
      assert.equal(badBody.data.radius, 10, 'radius outside 3|5|10 defaults to 10 at the route');
    });
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('close', r)).catch(() => {});
  }
}

main().catch((e) => {
  console.error('batch183-leads-explorer-regressions FAILED:', e);
  process.exit(1);
});
