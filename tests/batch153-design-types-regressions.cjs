'use strict';
/**
 * Batch 153 — DESIGN TYPES (Ely's order 2026-11-06: an editable
 * design-type + design-instructions list in Admin → Design agent;
 * the New design job popup's Type select is populated from it and
 * selecting a type fills the job's Instructions; "populate default
 * for each type" — every seeded type carries real default
 * instructions, website's being the existing guide VERBATIM).
 *
 * What is pinned here:
 *   Part 1 — seeds + registration: the six seed types in order,
 *     website byte-equal to DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS,
 *     the other five authored (non-empty, 550–1,600 words, pairwise
 *     distinct, distinct from website); the design.types platform
 *     def (group 'design', default ''), SETTABLE_KEYS registration,
 *     WORKSPACE_SEED_KEYS exclusion; source pins for the admin
 *     endpoints, the popup's catalog read + fill helper, the Admin
 *     tab, and the removed DESIGN_TYPES constant.
 *   Part 2 — validation units: canonicalization, duplicate /
 *     empty / over-long / bad-charset names refused, the
 *     20,000-char instructions cap (20,001 refused, 20,000
 *     accepted), empty instructions allowed, the settings-string
 *     form ('' → ''), and settingsKeys.validateSetting parity.
 *   Part 3 — in-process resolver + jobs: no stored row → the seed
 *     resolves; a saved list replaces it; a job created with a
 *     newly added type snapshots its type + instructions and is
 *     untouched when the type is later deleted from the catalog;
 *     clearing the stored value returns the seed.
 *   Part 4 — the popup fill rule: designTypeFill sliced out of
 *     public/js/app.js and eval'd — empty box fills, untouched
 *     auto-fill swaps, hand-typed words are never overwritten.
 *   Part 5 — HTTP over the real server: super-admin GET serves the
 *     seeded catalog (seeded=true, website byte-equal), the popup
 *     endpoint carries the same types; PUT add → popup serves it,
 *     PUT edit → popup serves the edit, invalid PUTs are 400s and
 *     write nothing; a job queued with the new type keeps it after
 *     the type is deleted; the generic settings save with '' →
 *     the seed returns; unauthenticated + non-super-admin refused.
 *   Part 6 — the follow-up wiring (Ely approved): the three
 *     direct-constant consumers now resolve through the catalog —
 *     server/museAgent's hands-off prompt (in-process: edited
 *     catalog → the prompt opens with the edit; seed → byte-equal
 *     to the constant; a corrupt stored row → the constant via the
 *     resolver's seed fallback), and the two src-side consumers via
 *     designJobs.resolveDefaultWebsiteInstructions (platform store
 *     → local settings → constant), exercised at the level each
 *     allows: the Electron IPC handler invoked through a stub
 *     ipcMain against a real local db, and src/mcp.js's
 *     website.create driven through handleRequest against its own
 *     WS_DB_PATH fixture db (the job it creates carries the
 *     resolved instructions). For each: edited → the edit, seed →
 *     the constant byte-for-byte, corrupt → the constant.
 *
 * B153_SKIP_HTTP=1 skips Part 5 locally; the gate runs everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b153-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch153', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 23).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b153@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['b153', 'fixture', 'pw'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B153 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';

const PORT = 31553;
const BASE = `http://127.0.0.1:${PORT}`;

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
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
async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;

(async () => {
  const seeds = require(path.join(root, 'src', 'defaultDesignInstructions.js'));
  const designTypes = require(path.join(root, 'server', 'designTypes.js'));
  const platform = require(path.join(root, 'server', 'platform.js'));
  const settingsKeys = require(path.join(root, 'server', 'settingsKeys.js'));

  /* ================================================================== */
  /* Part 1 — seeds + registration + source pins                         */
  /* ================================================================== */
  {
    let n = 0;
    const list = seeds.seedDesignTypes();
    assert.deepEqual(
      list.map((t) => t.type),
      ['website', 'logo', 'social', 'flyer', 'brand', 'other'],
      'the six seeded types in the historical popup order'
    );
    n++;
    assert.equal(list[0].instructions, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'website seed is the guide verbatim');
    assert.equal(list[0].instructions.length, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS.length, 'byte-for-byte length');
    n++;
    for (const t of list) assert.ok(t.instructions.trim().length > 0, `${t.type} seeds with non-empty instructions`);
    n++;
    for (const t of list.slice(1)) {
      const w = words(t.instructions);
      assert.ok(w >= 550 && w <= 1600, `${t.type} default is proportionate (${w} words)`);
    }
    n++;
    assert.equal(new Set(list.map((t) => t.instructions)).size, 6, 'all six instruction texts are distinct');
    n++;
    // seedDesignTypes returns fresh copies — mutating one must not
    // poison the constants.
    list[0].instructions = 'tampered';
    assert.equal(seeds.seedDesignTypes()[0].instructions, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'seed copies are fresh');
    n++;

    const def = platform.PLATFORM_SETTING_DEFS.find((d) => d.key === 'design.types');
    assert.ok(def, 'design.types platform def registered');
    assert.equal(def.group, 'design', 'platform-level group');
    assert.equal(def.default, '', "stored default is '' (the seed resolves)");
    n++;
    assert.ok(settingsKeys.SETTABLE_KEYS.includes('design.types'), 'SETTABLE_KEYS registration');
    n++;
    assert.ok(!platform.WORKSPACE_SEED_KEYS.includes('design.types'), 'never seeded into workspace storage');
    n++;

    const adminSrc = read('server/routes/admin.js');
    assert.ok(adminSrc.includes("router.get('/settings/design-types'"), 'admin GET endpoint');
    assert.ok(adminSrc.includes("router.put('/settings/design-types'"), 'admin PUT endpoint');
    n++;
    const appSrc = read('public/js/app.js');
    assert.ok(!appSrc.includes('DESIGN_TYPES'), 'the hardcoded DESIGN_TYPES constant is gone');
    assert.ok(appSrc.includes("['design', 'Design agent']"), 'Admin → Design agent tab');
    assert.ok(appSrc.includes('renderAdminDesignTypes'), 'the catalog editor renderer exists');
    assert.ok(appSrc.includes('data.types'), 'the popup reads the catalog from the payload');
    assert.ok(appSrc.includes('designTypeFill('), 'the popup fills via the pure helper');
    n++;
    const domainSrc = read('server/domain.js');
    assert.ok(domainSrc.includes("require('./designTypes').resolveDesignTypes()"), 'default-instructions resolves the catalog');
    n++;
    group('Part 1 seeds + registration + source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — validation units                                           */
  /* ================================================================== */
  {
    let n = 0;
    const v = designTypes.validateDesignTypes;
    const good = [
      { type: ' website ', instructions: '  spaced text kept as-is  ' },
      { type: 'Logo', instructions: '' },
    ];
    const out = v(good);
    assert.equal(out[0].type, 'website', 'names are trimmed');
    assert.equal(out[0].instructions, '  spaced text kept as-is  ', 'instructions are stored verbatim');
    assert.equal(out[1].instructions, '', 'empty instructions are allowed (blank-box types)');
    n++;
    assert.throws(() => v([{ type: 'Logo', instructions: '' }, { type: 'logo', instructions: '' }]), /duplicates/i, 'duplicate names refused case-insensitively');
    n++;
    assert.throws(() => v([{ type: '  ', instructions: '' }]), /needs a name/i, 'empty name refused');
    n++;
    assert.throws(() => v([{ type: 'x'.repeat(41), instructions: '' }]), /at most 40 characters/i, 'over-long name refused');
    assert.equal(v([{ type: 'x'.repeat(40), instructions: '' }]).length, 1, 'a 40-char name is accepted');
    n++;
    assert.throws(() => v([{ type: 'bad<type>', instructions: '' }]), /may only use/i, 'bad charset refused');
    n++;
    assert.throws(() => v([{ type: 'ok', instructions: 'a'.repeat(20001) }]), /limit is 20000/i, '20,001-char instructions refused');
    assert.equal(v([{ type: 'ok', instructions: 'a'.repeat(20000) }])[0].instructions.length, 20000, 'exactly 20,000 accepted');
    n++;
    assert.throws(() => v([]), /at least one/i, 'an empty list is refused');
    assert.throws(() => v('not json'), /JSON list/i, 'a non-JSON string is refused');
    assert.throws(() => v(42), /must be a list/i, 'a non-list is refused');
    n++;
    assert.deepEqual(v(JSON.stringify(good)), out, 'the JSON-string form validates identically');
    n++;
    assert.equal(designTypes.validateDesignTypesSetting(''), '', "the setting form canonicalizes '' to ''");
    assert.equal(
      designTypes.validateDesignTypesSetting(JSON.stringify(good)),
      JSON.stringify(out),
      'the setting form stores canonical JSON'
    );
    n++;
    const viaKeys = settingsKeys.validateSetting('design.types', JSON.stringify(good));
    assert.equal(viaKeys.ok, true, 'validateSetting accepts a valid catalog');
    assert.equal(viaKeys.value, JSON.stringify(out), 'validateSetting canonicalizes identically');
    assert.equal(settingsKeys.validateSetting('design.types', '').ok, true, "validateSetting accepts '' (seed)");
    assert.equal(settingsKeys.validateSetting('design.types', '[{"type":"x","instructions":""}]').ok, true, 'validateSetting accepts a minimal list');
    assert.equal(
      settingsKeys.validateSetting('design.types', JSON.stringify([{ type: 'x', instructions: 'a'.repeat(20001) }])).ok,
      false,
      'validateSetting refuses over-limit instructions'
    );
    n++;
    group('Part 2 validation units', n);
  }

  /* ================================================================== */
  /* Part 3 — in-process resolver + job snapshot integrity               */
  /* ================================================================== */
  {
    let n = 0;
    await require(path.join(root, 'server', 'db.js')).migrate();
    await platform.seedPlatformDefaults();

    // No stored row → the seed resolves, flagged as seeded.
    let state = await designTypes.refreshDesignTypes();
    assert.equal(state.seeded, true, 'nothing stored → seeded');
    assert.deepEqual(
      state.types.map((t) => t.type),
      ['website', 'logo', 'social', 'flyer', 'brand', 'other'],
      'the seed serves the six types'
    );
    assert.equal(state.types[0].instructions, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'seeded website text verbatim');
    n++;
    const admin0 = await designTypes.adminState();
    assert.equal(admin0.seeded, true, 'admin state reports the seed');
    assert.equal(admin0.limits.maxInstructionsChars, 20000, 'limits ride the admin state');
    n++;

    // Save a custom catalog (seed six + a brand-new type).
    const custom = [
      ...seeds.seedDesignTypes(),
      { type: 'mural', instructions: 'Paint the wall. ZZ153 mural instructions.' },
    ];
    const saved = await designTypes.updateDesignTypes(custom);
    assert.equal(saved.seeded, false, 'a saved catalog is not the seed');
    assert.equal(saved.updated, 7, 'the save reports its entry count');
    state = designTypes.resolveDesignTypes();
    assert.equal(state.types.length, 7, 'the resolver serves the saved list synchronously');
    assert.equal(state.types[6].type, 'mural', 'the new type resolves');
    n++;
    // The stored row is the canonical JSON of exactly what was saved.
    const stored = await platform.getStoredPlatformSetting('design.types');
    assert.deepEqual(JSON.parse(stored), custom, 'the stored row is the canonical catalog');
    n++;

    // A job created with the newly added type snapshots type +
    // instructions at creation.
    const domain = require(path.join(root, 'server', 'domain.js'));
    const designJobs = require(path.join(root, 'src', 'designJobs.js'));
    const realDb = domain.withDb(1, (db) => db);
    designJobs.ensureTables(realDb);
    const job = designJobs.createJob(realDb, {
      type: 'mural',
      title: 'ZZ153 mural job',
      instructions: 'Paint the wall. ZZ153 mural instructions.',
    });
    assert.equal(job.type, 'mural', 'the job carries the new type');
    assert.equal(job.instructions, 'Paint the wall. ZZ153 mural instructions.', 'the job snapshots its instructions');
    n++;

    // Deleting the type from the catalog leaves the job untouched.
    await designTypes.updateDesignTypes(seeds.seedDesignTypes());
    const row = realDb.prepare('SELECT type, instructions FROM design_jobs WHERE id = ?').get(job.id);
    assert.equal(row.type, 'mural', 'deleting the catalog type leaves the job type intact');
    assert.equal(row.instructions, 'Paint the wall. ZZ153 mural instructions.', '…and its instructions intact');
    n++;

    // Clearing the stored value returns the seed (the supported
    // "store emptied" path — through the settings choke point).
    await platform.setPlatformSetting('design.types', '');
    state = designTypes.resolveDesignTypes();
    assert.equal(state.seeded, true, 'a cleared store resolves the seed again');
    assert.equal(state.types.length, 6, 'the seeded six return');
    n++;

    // domain.designDefaultInstructions serves the same catalog.
    const payload = domain.designDefaultInstructions();
    assert.equal(payload.website, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'the payload website text is the seed verbatim');
    assert.deepEqual(
      payload.types.map((t) => t.type),
      ['website', 'logo', 'social', 'flyer', 'brand', 'other'],
      'the payload types are the catalog'
    );
    assert.ok(Array.isArray(payload.assets), 'the design assets still ride the payload');
    n++;
    group('Part 3 resolver + job snapshots', n);
  }

  /* ================================================================== */
  /* Part 4 — the popup fill rule (designTypeFill out of app.js)         */
  /* ================================================================== */
  {
    let n = 0;
    const appSrc = read('public/js/app.js');
    const start = appSrc.indexOf('function designTypeFill(');
    assert.ok(start > 0, 'designTypeFill found in app.js');
    const end = appSrc.indexOf('\n}\n', start);
    assert.ok(end > start, 'designTypeFill bounds found');
    const fill = vm.runInNewContext(`${appSrc.slice(start, end + 3)}; designTypeFill;`, {});
    assert.equal(typeof fill, 'function', 'the helper evals standalone');
    n++;
    assert.equal(fill('', '', 'LOGO TEXT'), 'LOGO TEXT', 'an empty box takes the selected type text');
    assert.equal(fill('   ', 'WEB TEXT', 'LOGO TEXT'), 'LOGO TEXT', 'a whitespace-only box fills');
    assert.equal(fill('WEB TEXT', 'WEB TEXT', 'LOGO TEXT'), 'LOGO TEXT', 'an untouched auto-fill swaps to the new type');
    assert.equal(fill('WEB TEXT', 'WEB TEXT', ''), '', 'switching to an empty-instructions type clears an untouched box');
    n++;
    assert.equal(fill('my own words', 'WEB TEXT', 'LOGO TEXT'), 'my own words', 'hand-typed words are never overwritten');
    assert.equal(fill('WEB TEXT plus mine', 'WEB TEXT', 'LOGO TEXT'), 'WEB TEXT plus mine', 'an edited auto-fill is the user\u2019s own');
    assert.equal(fill('my own words', 'WEB TEXT', ''), 'my own words', '…not even by an empty type');
    n++;
    group('Part 4 popup fill rule', n);
  }

  /* ================================================================== */
  /* Part 5 — HTTP over the real server                                  */
  /* ================================================================== */
  if (process.env.B153_SKIP_HTTP === '1') {
    console.log('  skip Part 5 HTTP (B153_SKIP_HTTP=1 — local iteration only)');
  } else {
    let n = 0;
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
      for (let i = 0; i < 300 && !ready; i++) {
        if (child.exitCode != null) throw new Error('server exited early: ' + output);
        try {
          const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
          if (r.ok) ready = true;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ready, 'server became ready');
      n++;

      // Unauthenticated access is refused.
      let res = await fetch(`${BASE}/api/v1/admin/settings/design-types`);
      assert.ok([401, 403].includes(res.status), 'GET design-types requires auth: ' + res.status);
      res = await fetch(`${BASE}/api/v1/admin/settings/design-types`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ types: [] }),
      });
      assert.ok([401, 403].includes(res.status), 'PUT design-types requires auth: ' + res.status);
      n++;

      // Bootstrap super-admin session (login → MFA enroll → confirm).
      const jar = makeJar();
      const post = (p, body) =>
        jar.fetch(BASE + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
      const login = async (j, email, password) => {
        const postJ = (p, body) =>
          j.fetch(BASE + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          });
        const totp = require(path.join(root, 'src', 'totp.js'));
        let r = await postJ('/api/v1/auth/login', { email, password });
        let b = await json(r);
        assert.equal(r.status, 200, 'login 200 for ' + email);
        if (b.data && b.data.mfaRequired === true) {
          r = await postJ('/api/v1/auth/mfa/enroll/start', {});
          b = await json(r);
          assert.ok(b.data && b.data.secret, 'enroll secret issued for ' + email);
          r = await postJ('/api/v1/auth/mfa/enroll/confirm', { code: totp.totp(b.data.secret) });
          b = await json(r);
          assert.equal(r.status, 200, 'MFA confirm 200 for ' + email);
        }
        return b;
      };
      await login(jar, process.env.BOOTSTRAP_EMAIL, process.env.BOOTSTRAP_PASSWORD);
      n++;

      const getAdmin = async () => {
        const r = await jar.fetch(`${BASE}/api/v1/admin/settings/design-types`);
        assert.equal(r.status, 200, 'GET design-types 200');
        return (await json(r)).data;
      };
      const getPopup = async () => {
        const r = await jar.fetch(`${BASE}/api/v1/design/default-instructions`);
        assert.equal(r.status, 200, 'GET default-instructions 200');
        return (await json(r)).data;
      };
      const putAdmin = (types) =>
        jar.fetch(`${BASE}/api/v1/admin/settings/design-types`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ types }),
        });

      // Fresh server: the seeded catalog, website verbatim.
      let state = await getAdmin();
      assert.equal(state.seeded, true, 'a fresh server serves the seed');
      assert.deepEqual(
        state.types.map((t) => t.type),
        ['website', 'logo', 'social', 'flyer', 'brand', 'other'],
        'the seeded six over HTTP'
      );
      assert.equal(state.types[0].instructions, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'website byte-equal over HTTP');
      for (const t of state.types) assert.ok(t.instructions.trim().length > 0, `${t.type} non-empty over HTTP`);
      n++;
      let popup = await getPopup();
      assert.deepEqual(
        popup.types.map((t) => t.type),
        state.types.map((t) => t.type),
        'the popup endpoint carries the same catalog'
      );
      assert.equal(popup.website, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'popup website text byte-equal');
      assert.ok(Array.isArray(popup.assets), 'assets still ride the popup payload');
      n++;

      // Add a type → the popup serves it. Edit it → the popup serves
      // the edit.
      const withMural = [...state.types, { type: 'mural', instructions: 'ZZ153 mural v1 — paint the wall.' }];
      res = await putAdmin(withMural);
      assert.equal(res.status, 200, 'PUT add-type 200');
      state = await getAdmin();
      assert.equal(state.seeded, false, 'a saved catalog is no longer the seed');
      popup = await getPopup();
      const mural = popup.types.find((t) => t.type === 'mural');
      assert.ok(mural, 'the new type reaches the popup endpoint');
      assert.equal(mural.instructions, 'ZZ153 mural v1 — paint the wall.', '…with its instructions');
      n++;
      const edited = state.types.map((t) =>
        t.type === 'mural' ? { ...t, instructions: 'ZZ153 mural v2 — paint TWO walls.' } : t
      );
      res = await putAdmin(edited);
      assert.equal(res.status, 200, 'PUT edit 200');
      popup = await getPopup();
      assert.equal(
        popup.types.find((t) => t.type === 'mural').instructions,
        'ZZ153 mural v2 — paint TWO walls.',
        'the popup serves the edited instructions'
      );
      n++;

      // Invalid PUTs are 400s and write nothing.
      const badLists = [
        [...edited, { type: 'MURAL', instructions: '' }], // duplicate, case-insensitive
        [...edited, { type: '   ', instructions: '' }], // empty name
        edited.map((t) => (t.type === 'mural' ? { ...t, instructions: 'a'.repeat(20001) } : t)), // over the cap
        [...edited, { type: 'bad<type>', instructions: '' }], // charset
      ];
      for (const bad of badLists) {
        res = await putAdmin(bad);
        assert.equal(res.status, 400, 'invalid catalog rejected: ' + JSON.stringify(bad[bad.length - 1]).slice(0, 60));
        n++;
      }
      state = await getAdmin();
      assert.equal(state.types.length, 7, 'rejected PUTs wrote nothing (count)');
      assert.equal(
        state.types.find((t) => t.type === 'mural').instructions,
        'ZZ153 mural v2 — paint TWO walls.',
        'rejected PUTs wrote nothing (content)'
      );
      n++;

      // Queue a job with the new type; then delete the type — the
      // job keeps its type + instructions snapshot.
      res = await post('/api/v1/design', {
        type: 'mural',
        title: 'ZZ153 HTTP mural job',
        instructions: 'ZZ153 mural v2 — paint TWO walls.',
      });
      let body = await json(res);
      assert.equal(res.status, 200, 'POST /design 200: ' + JSON.stringify(body).slice(0, 200));
      const jobId = body.data.job.id;
      assert.equal(body.data.job.type, 'mural', 'the queued job carries the new type');
      assert.equal(body.data.job.instructions, 'ZZ153 mural v2 — paint TWO walls.', '…and its instructions snapshot');
      n++;
      res = await putAdmin(state.types.filter((t) => t.type !== 'mural'));
      assert.equal(res.status, 200, 'PUT delete-type 200');
      popup = await getPopup();
      assert.ok(!popup.types.some((t) => t.type === 'mural'), 'the deleted type leaves the popup');
      res = await jar.fetch(`${BASE}/api/v1/design/${jobId}`);
      body = await json(res);
      assert.equal(res.status, 200, 'GET the orphaned job 200');
      assert.equal(body.data.job.type, 'mural', 'the job keeps its type after the catalog delete');
      assert.equal(body.data.job.instructions, 'ZZ153 mural v2 — paint TWO walls.', 'the job keeps its instructions');
      n++;

      // Emptying the store through the generic settings save returns
      // the seed everywhere.
      res = await jar.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { 'design.types': '' } }),
      });
      assert.equal(res.status, 200, 'generic settings save 200');
      state = await getAdmin();
      assert.equal(state.seeded, true, 'an emptied store serves the seed again');
      popup = await getPopup();
      assert.equal(popup.website, seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS, 'the popup website text is the verbatim seed again');
      n++;

      // A non-super-admin session is refused on both verbs.
      const plainPw = ['b153', 'plain', 'pw'].join('-');
      res = await post('/api/v1/admin/users', { email: 'plain-b153@example.invalid', password: plainPw, name: 'Plain B153' });
      body = await json(res);
      assert.equal(res.status, 200, 'plain user created: ' + JSON.stringify(body).slice(0, 160));
      const jar2 = makeJar();
      await login(jar2, 'plain-b153@example.invalid', plainPw);
      res = await jar2.fetch(`${BASE}/api/v1/admin/settings/design-types`);
      assert.equal(res.status, 403, 'non-super-admin GET refused: ' + res.status);
      res = await jar2.fetch(`${BASE}/api/v1/admin/settings/design-types`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ types: state.types }),
      });
      assert.equal(res.status, 403, 'non-super-admin PUT refused: ' + res.status);
      n++;
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    group('Part 5 HTTP admin + popup endpoints', n);
  }

  /* ================================================================== */
  /* Part 6 — the follow-up wiring: the three direct-constant          */
  /* consumers resolve through the catalog                             */
  /* ================================================================== */
  {
    let n = 0;
    const museAgent = require(path.join(root, 'server', 'museAgent.js'));
    const serverDb = require(path.join(root, 'server', 'db.js'));
    const designJobs = require(path.join(root, 'src', 'designJobs.js'));
    const Database = require('better-sqlite3');
    const CONSTANT = seeds.DEFAULT_WEBSITE_DESIGN_INSTRUCTIONS;
    const EDIT_P = 'ZZ153 PLATFORM EDIT — the catalog website text from the platform store.';
    const EDIT_L = 'ZZ153 LOCAL EDIT — the catalog website text from a local settings table.';
    const editedCatalog = (text) =>
      seeds.seedDesignTypes().map((t) => (t.type === 'website' ? { type: 'website', instructions: text } : t));
    const promptJob = { id: 153, title: 'ZZ153 prompt fixture' };

    // Source pins: the three consumers route through the catalog,
    // and the shared src resolver exists + is exported.
    const museSrc = read('server/museAgent.js');
    assert.ok(museSrc.includes("require('./designTypes')"), 'museAgent requires the catalog resolver');
    assert.ok(museSrc.includes('catalogWebsiteInstructions()'), 'the hands-off prompt opens via the catalog helper');
    assert.equal(typeof museAgent.buildSystemPrompt, 'function', 'buildSystemPrompt is exported for this suite');
    n++;
    const jobsSrc = read('src/designJobs.js');
    assert.ok(jobsSrc.includes('async function resolveDefaultWebsiteInstructions(db)'), 'the src resolver exists');
    assert.equal(typeof designJobs.resolveDefaultWebsiteInstructions, 'function', '…and is exported');
    const ipcSrc = read('src/ipc/design.js');
    assert.ok(ipcSrc.includes('design.resolveDefaultWebsiteInstructions(db)'), 'the IPC handler resolves via the catalog');
    assert.ok(!ipcSrc.includes('design.defaultWebsiteInstructions()'), 'the IPC handler no longer reads the constant directly');
    n++;
    const mcpSrc = read('src/mcp.js');
    assert.ok(mcpSrc.includes('design.resolveDefaultWebsiteInstructions(db)'), 'website.create resolves via the catalog');
    assert.ok(!mcpSrc.includes('design.defaultWebsiteInstructions()'), 'src/mcp.js no longer reads the constant directly');
    n++;

    /* --- consumer 1: server/museAgent.js (in-process) --- */
    // Seed state (Part 5 left the store cleared): the prompt opens
    // with the constant, byte-for-byte the pre-153 prompt head.
    let prompt = museAgent.buildSystemPrompt(promptJob);
    assert.ok(prompt.startsWith(CONSTANT), 'seed catalog → the hands-off prompt opens with the constant verbatim');
    n++;
    // Edited catalog → the prompt opens with the edit.
    await designTypes.updateDesignTypes(editedCatalog(EDIT_P));
    prompt = museAgent.buildSystemPrompt(promptJob);
    assert.ok(prompt.startsWith(EDIT_P), 'edited catalog → the prompt opens with the Admin edit');
    assert.ok(!prompt.startsWith(CONSTANT), '…and not with the constant');
    n++;
    // Corrupt stored row → the resolver falls back to the seed and
    // the prompt is the constant again.
    await serverDb.query("UPDATE platform_settings SET value = :v WHERE `key` = 'design.types'", { v: '{corrupt' });
    assert.equal(await platform.getStoredPlatformSetting('design.types'), '{corrupt', 'the corrupt row landed');
    const refreshed = await designTypes.refreshDesignTypes();
    assert.equal(refreshed.seeded, true, 'a corrupt row resolves to the seed');
    prompt = museAgent.buildSystemPrompt(promptJob);
    assert.ok(prompt.startsWith(CONSTANT), 'corrupt catalog → the prompt opens with the constant');
    await platform.setPlatformSetting('design.types', '');
    n++;

    /* --- shared fixture: a desktop-style local db --- */
    const localDb = new Database(path.join(temp, 'b153-local.db'));
    localDb.exec(read('src/schema.sql'));
    const setLocal = (value) =>
      localDb
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('design.types', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(value);
    const clearLocal = () => localDb.prepare("DELETE FROM settings WHERE key = 'design.types'").run();

    /* --- consumer 2: src/ipc/design.js (stub ipcMain, real db) --- */
    const handlers = new Map();
    require(path.join(root, 'src', 'ipc', 'design.js')).register(
      { handle: (name, fn) => handlers.set(name, fn) },
      localDb
    );
    const ipcDefaults = async () => {
      const res = await handlers.get('design:defaultInstructions')({}, {});
      assert.equal(res.ok, true, 'the IPC handler answers ok');
      return res.website;
    };
    assert.equal(await ipcDefaults(), CONSTANT, 'IPC: no store anywhere → the constant');
    n++;
    setLocal(JSON.stringify(editedCatalog(EDIT_L)));
    assert.equal(await ipcDefaults(), EDIT_L, 'IPC: a local settings catalog → its website entry');
    n++;
    await designTypes.updateDesignTypes(editedCatalog(EDIT_P));
    assert.equal(await ipcDefaults(), EDIT_P, 'IPC: the platform store wins over the local one (Admin edits reach it)');
    n++;
    await serverDb.query("UPDATE platform_settings SET value = :v WHERE `key` = 'design.types'", { v: '{corrupt' });
    assert.equal(await ipcDefaults(), CONSTANT, 'IPC: a corrupt platform catalog → the constant (the local row does not leak through)');
    await platform.setPlatformSetting('design.types', '');
    n++;
    setLocal('{corrupt');
    assert.equal(await ipcDefaults(), CONSTANT, 'IPC: a corrupt local catalog → the constant');
    clearLocal();
    n++;

    /* --- consumer 3: src/mcp.js website.create (handleRequest) --- */
    process.env.WS_DB_PATH = path.join(temp, 'b153-mcp.db');
    const mcp = require(path.join(root, 'src', 'mcp.js'));
    assert.equal(mcp.DB_PATH, process.env.WS_DB_PATH, 'the MCP fixture db is the one under test');
    const mcpDb = new Database(process.env.WS_DB_PATH);
    const leadId = Number(
      mcpDb.prepare('INSERT INTO leads (business_name) VALUES (?)').run('ZZ153 MCP Fixture').lastInsertRowid
    );
    const setMcpLocal = (value) =>
      mcpDb
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('design.types', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(value);
    const createViaMcp = async () => {
      const res = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'website.create', arguments: { leadId } },
      });
      const payload = JSON.parse(res.result.content[0].text);
      assert.equal(payload.ok, true, 'website.create succeeds: ' + JSON.stringify(payload).slice(0, 160));
      return mcpDb.prepare('SELECT instructions FROM design_jobs WHERE id = ?').get(payload.data.jobId).instructions;
    };
    assert.equal(await createViaMcp(), CONSTANT, 'MCP: no store anywhere → the created job carries the constant');
    n++;
    setMcpLocal(JSON.stringify(editedCatalog(EDIT_L)));
    assert.equal(await createViaMcp(), EDIT_L, 'MCP: a local settings catalog → the job carries its website entry');
    n++;
    await designTypes.updateDesignTypes(editedCatalog(EDIT_P));
    assert.equal(await createViaMcp(), EDIT_P, 'MCP: the platform store wins (Admin edits reach auto-created jobs)');
    await platform.setPlatformSetting('design.types', '');
    n++;
    setMcpLocal('{corrupt');
    assert.equal(await createViaMcp(), CONSTANT, 'MCP: a corrupt local catalog → the job carries the constant');
    mcpDb.prepare("DELETE FROM settings WHERE key = 'design.types'").run();
    n++;

    group('Part 6 consumer wiring (museAgent + IPC + src MCP)', n);
  }

  console.log(`BATCH153 REGRESSION PASS — ${groups.join('; ')}`);
})().catch((e) => {
  console.error('BATCH153 REGRESSION FAIL', e);
  process.exit(1);
});
