'use strict';
/**
 * Batch 158 — GOOGLE REVIEWS → SOCIAL CALENDAR (plan Phase 9; Ely's
 * order 2026-11-07 "Build both now", default D9: approve-first drafts,
 * no auto-publish in v1).
 *
 * The Batch 30 googlereviews module fetches + caches a site's Google
 * reviews (24h cache, per-site Place ID + min_rating). This batch adds
 * a per-site opt-in — `share_to_social` on the module's existing
 * config, default OFF — and a bridge through the Batch 122 shared
 * layer (server/moduleShare.js): whenever a reviews cache is stored
 * (portal refresh, lazy refresh, Place-ID-save prefetch — all funnel
 * through storeGoogleReviewsCache), new cached reviews at or above
 * min_rating become DRAFT posts on the site's social calendar. No
 * extra Places API calls — the cache is the only source.
 *
 * What is pinned here:
 *   Part 1 — surfaces + config: the share_to_social column migrates
 *     onto a pre-existing config table (house PRAGMA pattern) and
 *     round-trips through update/read (default OFF, camelCase alias
 *     accepted, unrelated saves preserve it); the dedupe table exists;
 *     the portal pane carries the toggle checkbox bound to
 *     cfg.share_to_social and the save body sends it; the portal save
 *     forwards the body to updateGoogleReviewsConfig (so the toggle
 *     persists with no route change); the store hook + shared-layer
 *     bridge exports exist; MCP config parity comes from the same
 *     update function.
 *   Part 2 — bridge behaviour on seeded caches (Batch 30 style, no
 *     network): toggle OFF stores create nothing; ON creates drafts
 *     only for reviews ≥ min_rating (below-min skipped, max_reviews
 *     display cap NOT applied to sharing); captions carry the star
 *     row, the review text UNALTERED (special characters intact), the
 *     reviewer name, the Google attribution and the place's Maps link;
 *     a second store creates NO duplicates (dedupe map keyed on
 *     sha256(author+publish_time+text), Places name-keyed when a
 *     payload carries one); a later store with one new review creates
 *     exactly one more draft; drafts sit on FUTURE days at 14:00 UTC,
 *     at most one review post per day, in a dedicated monthly reviews
 *     campaign (active, require_client_approval=1, America/New_York);
 *     every created post is status 'draft' — no publish path fires.
 *     Escaping: captions are stored raw by calendar convention and
 *     the calendar renders them escaped (portal esc() pin).
 *   Part 3 — HTTP over the real server: boot is clean; the portal
 *     config route refuses anonymous callers; staff sign-in works.
 *     (The end-to-end seeded-cache proof on production runs at deploy
 *     time on a throwaway lead; real-Google proof waits for the
 *     platform Places key, which does not exist yet.)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b158-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.PLATFORM_DB_PATH = process.env.SQLITE_PATH;
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch158', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 47).toString('base64');
process.env.BOOTSTRAP_EMAIL = 'owner-b158@example.invalid';
process.env.BOOTSTRAP_PASSWORD = ['batch158', 'bootstrap', 'pw'].join('-');
process.env.BOOTSTRAP_WORKSPACE = 'B158 Fixture';
process.env.BOOTSTRAP_SUPER_ADMIN = '1';
process.env.MAIL_DRY_RUN = 'true';

const PORT = 31558;
const BASE = `http://127.0.0.1:${PORT}`;

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}

function tenantDb() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    Database = require('node:sqlite').DatabaseSync;
  }
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  require(path.join(root, 'src/websiteEngine')).ensureTables(db);
  require(path.join(root, 'src/socialMedia')).ensureTables(db);
  return db;
}

const REVIEWS = [
  { author: 'Jane D.', author_uri: '', photo_uri: '', rating: 5, relative_time: 'a week ago', publish_time: '2026-11-01T10:00:00Z', text: 'Best <b>ever</b> & "great" service — 100% recommend!' },
  { author: 'Bob', author_uri: '', photo_uri: '', rating: 4, relative_time: '2 weeks ago', publish_time: '2026-10-25T09:00:00Z', text: 'Good work, fair price.' },
  { author: 'Sal', author_uri: '', photo_uri: '', rating: 2, relative_time: 'a month ago', publish_time: '2026-10-01T09:00:00Z', text: 'Meh.' },
  { author: 'Ana', author_uri: '', photo_uri: '', rating: 5, relative_time: '2 days ago', publish_time: '2026-11-05T09:00:00Z', text: '' },
];
const PAYLOAD = {
  name: 'Maple Bakery',
  rating: 4.6,
  total: 57,
  google_maps_uri: 'https://maps.google.com/?cid=123',
  reviews: REVIEWS,
};

(async () => {
  /* ================================================================== */
  /* Part 1 — surfaces + config                                          */
  /* ================================================================== */
  {
    let n = 0;
    const modules = require(path.join(root, 'server/siteModules.js'));
    const share = require(path.join(root, 'server/moduleShare.js'));
    assert.equal(typeof share.shareGoogleReviewsToSocial, 'function', 'shared layer exports the bridge');
    n++;
    assert.equal(typeof share.googleReviewKey, 'function', 'shared layer exports the dedupe key fn');
    n++;
    const smSrc = read('server/siteModules.js');
    assert.ok(smSrc.includes("require('./moduleShare').shareGoogleReviewsToSocial(db, Number(leadId))"), 'cache-store hook calls the shared layer');
    n++;
    assert.ok(smSrc.includes('CREATE TABLE IF NOT EXISTS googlereviews_social_posts'), 'dedupe table DDL present');
    n++;
    assert.ok(smSrc.includes("ALTER TABLE googlereviews_configs ADD COLUMN share_to_social"), 'toggle column migration present');
    n++;
    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('id="googlereviews-share-social"'), 'portal pane carries the toggle checkbox');
    n++;
    assert.ok(portalSrc.includes("cfg.share_to_social ? ' checked' : ''"), 'checkbox binds to the stored config');
    n++;
    assert.ok(portalSrc.includes("share_to_social: chk('googlereviews-share-social')"), 'save body sends the toggle');
    n++;
    const pmSrc = read('server/portalModules.js');
    assert.ok(pmSrc.includes('modules.updateGoogleReviewsConfig(db, id, body || {})'), 'portal save forwards the body to the config writer');
    n++;
    const mcpSrc = read('server/mcp.js');
    assert.ok(mcpSrc.includes('modules.updateGoogleReviewsConfig(db, leadId, a)'), 'MCP config write uses the same function (parity)');
    n++;

    // Config round-trip on a PRE-EXISTING table (migration path): build
    // the old-shape table by hand, then let ensureTables migrate it.
    const db = tenantDb();
    db.exec('DROP TABLE IF EXISTS googlereviews_configs');
    db.exec(`CREATE TABLE googlereviews_configs (
      lead_id INTEGER PRIMARY KEY,
      place_id TEXT NOT NULL DEFAULT '',
      max_reviews INTEGER NOT NULL DEFAULT 5,
      min_rating REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO googlereviews_configs (lead_id, place_id) VALUES (?, ?)').run(41, 'ChIJlegacy');
    modules.ensureTables(db);
    const cols = db.prepare('PRAGMA table_info(googlereviews_configs)').all().map((c) => String(c.name));
    assert.ok(cols.includes('share_to_social'), 'migration adds share_to_social to an existing table');
    n++;
    let cfg = modules.readGoogleReviewsConfig(db, 41);
    assert.equal(cfg.share_to_social, 0, 'existing rows default OFF');
    n++;
    assert.equal(cfg.place_id, 'ChIJlegacy', 'migration preserves existing config');
    n++;
    cfg = modules.updateGoogleReviewsConfig(db, 41, { shareToSocial: true });
    assert.equal(cfg.share_to_social, 1, 'camelCase toggle write round-trips ON');
    n++;
    cfg = modules.updateGoogleReviewsConfig(db, 41, { min_rating: 4 });
    assert.equal(cfg.share_to_social, 1, 'an unrelated save preserves the toggle');
    n++;
    assert.equal(cfg.min_rating, 4, 'min_rating still updates');
    n++;
    cfg = modules.updateGoogleReviewsConfig(db, 41, { share_to_social: false });
    assert.equal(cfg.share_to_social, 0, 'snake_case toggle write round-trips OFF');
    n++;
    const mapCols = db.prepare('PRAGMA table_info(googlereviews_social_posts)').all().map((c) => String(c.name));
    assert.deepEqual(mapCols.sort(), ['created_at', 'lead_id', 'review_key', 'social_post_id'].sort(), 'dedupe table shape');
    n++;
    group('Part 1 surfaces + config migration', n);
  }

  /* ================================================================== */
  /* Part 2 — bridge behaviour                                           */
  /* ================================================================== */
  {
    let n = 0;
    const modules = require(path.join(root, 'server/siteModules.js'));
    const share = require(path.join(root, 'server/moduleShare.js'));
    const db = tenantDb();
    modules.ensureTables(db);
    const info = db.prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, '', 'new')`).run('Maple Bakery');
    const leadId = Number(info.lastInsertRowid);
    const postsOf = () => db.prepare('SELECT * FROM social_posts WHERE lead_id = ? ORDER BY scheduled_at').all(leadId);

    // Toggle OFF (default): a cache store creates nothing.
    modules.storeGoogleReviewsCache(db, leadId, PAYLOAD);
    assert.equal(postsOf().length, 0, 'toggle OFF → no drafts');
    n++;
    assert.deepEqual(share.shareGoogleReviewsToSocial(db, leadId), { created: 0, skipped: 0, reason: 'off' }, 'bridge reports off');
    n++;

    // ON with min 4: 3 of 4 reviews qualify (2-star skipped).
    modules.updateGoogleReviewsConfig(db, leadId, { place_id: 'ChIJtest', min_rating: 4, share_to_social: true });
    modules.storeGoogleReviewsCache(db, leadId, PAYLOAD);
    const posts = postsOf();
    assert.equal(posts.length, 3, 'ON → drafts for the 3 reviews at/above min_rating');
    n++;
    assert.ok(posts.every((p) => p.status === 'draft'), 'every created post is a DRAFT (approve-first, no publish)');
    n++;
    assert.ok(posts.every((p) => !posts.some((q) => q !== p && q.scheduled_at.slice(0, 10) === p.scheduled_at.slice(0, 10))), 'at most one review post per day');
    n++;
    const nowDay = new Date().toISOString().slice(0, 10);
    assert.ok(posts.every((p) => p.scheduled_at.slice(0, 10) > nowDay), 'all drafts land on future dates');
    n++;
    assert.ok(posts.every((p) => p.scheduled_at.endsWith('T14:00:00.000Z')), 'drafts use the calendar 14:00 UTC posting time');
    n++;
    const days = posts.map((p) => p.scheduled_at.slice(0, 10)).sort();
    const consecutive = days.every((d, i) => i === 0 || (new Date(d) - new Date(days[i - 1])) / 86400000 === 1);
    assert.ok(consecutive, 'drafts step one per day consecutively');
    n++;

    // Caption content: stars, UNALTERED text, attribution, maps link.
    const jane = posts.find((p) => p.caption.includes('Jane D.'));
    assert.ok(jane, 'Jane review drafted');
    n++;
    assert.ok(jane.caption.startsWith('★★★★★\n'), 'caption opens with the star row');
    n++;
    assert.ok(jane.caption.includes('Best <b>ever</b> & "great" service — 100% recommend!'), 'review text stored UNALTERED (special characters intact)');
    n++;
    assert.ok(jane.caption.includes('— Jane D. · Google review'), 'reviewer name + Google attribution line');
    n++;
    assert.ok(jane.caption.includes('https://maps.google.com/?cid=123'), 'place Google Maps link appended');
    n++;
    const bob = posts.find((p) => p.caption.includes('Bob'));
    assert.ok(bob && bob.caption.startsWith('★★★★\n'), '4-star row for the 4-star review');
    n++;
    assert.ok(!posts.some((p) => p.caption.includes('Meh.')), 'below-min review never drafted');
    n++;

    // Campaign conventions.
    const camps = db.prepare('SELECT * FROM social_campaigns WHERE lead_id = ?').all(leadId);
    assert.equal(camps.length, 1, 'one dedicated reviews campaign');
    n++;
    assert.match(camps[0].title, /· Google reviews · \d{4}-\d{2}$/, 'campaign is self-describing');
    n++;
    assert.equal(camps[0].require_client_approval, 1, 'campaign requires client approval');
    n++;
    assert.equal(camps[0].timezone, 'America/New_York', 'campaign uses the calendar default timezone');
    n++;
    assert.ok(posts.every((p) => p.campaign_id === camps[0].id), 'drafts belong to the reviews campaign');
    n++;

    // Dedupe: a second identical store creates nothing.
    modules.storeGoogleReviewsCache(db, leadId, PAYLOAD);
    assert.equal(postsOf().length, 3, 'second store → NO duplicates');
    n++;
    const mapRows = db.prepare('SELECT * FROM googlereviews_social_posts WHERE lead_id = ?').all(leadId);
    assert.equal(mapRows.length, 3, 'dedupe map holds one row per drafted review');
    n++;
    assert.ok(mapRows.every((m) => m.review_key.startsWith('h:') && m.review_key.length === 66), 'hash keys for name-less cached reviews');
    n++;
    assert.equal(share.googleReviewKey({ name: 'places/x/reviews/y', author: 'A', publish_time: 't', text: 'z' }), 'name:places/x/reviews/y', 'Places name resource id wins when present');
    n++;

    // A later store with ONE new review creates exactly one more draft,
    // on the next free day.
    const p2 = {
      ...PAYLOAD,
      reviews: [...REVIEWS, { author: 'New Ned', author_uri: '', photo_uri: '', rating: 5, relative_time: 'now', publish_time: '2026-11-07T12:00:00Z', text: 'Just opened — lovely.' }],
    };
    modules.storeGoogleReviewsCache(db, leadId, p2);
    const after = postsOf();
    assert.equal(after.length, 4, 'one new review → exactly one new draft');
    n++;
    const ned = after.find((p) => p.caption.includes('New Ned'));
    assert.ok(ned && ned.scheduled_at.slice(0, 10) > days[days.length - 1], 'the new draft lands after the existing run');
    n++;

    // Toggling OFF stops future sharing; existing drafts stay drafts.
    modules.updateGoogleReviewsConfig(db, leadId, { share_to_social: false });
    const p3 = {
      ...PAYLOAD,
      reviews: [...p2.reviews, { author: 'Late Lou', author_uri: '', photo_uri: '', rating: 5, relative_time: 'now', publish_time: '2026-11-07T13:00:00Z', text: 'Late.' }],
    };
    modules.storeGoogleReviewsCache(db, leadId, p3);
    assert.equal(postsOf().length, 4, 'toggle OFF again → nothing new');
    n++;

    // No cache at all: bridge is a clean no-op.
    const info2 = db.prepare(`INSERT INTO leads (business_name, email, status) VALUES (?, '', 'new')`).run('No Cache Co');
    const lead2 = Number(info2.lastInsertRowid);
    modules.updateGoogleReviewsConfig(db, lead2, { share_to_social: true });
    assert.deepEqual(share.shareGoogleReviewsToSocial(db, lead2), { created: 0, skipped: 0, reason: 'no_cache' }, 'no cache → no-op');
    n++;

    // Escaping discipline: captions are stored raw by calendar
    // convention; the calendar surface escapes them at render.
    const portalSrc = read('public/js/portal.js');
    assert.ok(portalSrc.includes('${esc(p.caption || \'\')}'), 'portal calendar renders captions through esc()');
    n++;
    const socialSrc = read('src/socialMedia.js');
    assert.ok(socialSrc.includes('escapeHtml(lines)'), 'weekly-batch approve rendering escapes post text');
    n++;
    group('Part 2 bridge behaviour', n);
  }

  /* ================================================================== */
  /* Part 3 — HTTP over the real server                                  */
  /* ================================================================== */
  {
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
      const res = await fetch(`${BASE}/api/v1/portal/modules/googlereviews/config`, {
        method: 'PUT',
        headers: { 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
        body: JSON.stringify({ share_to_social: true }),
      });
      assert.ok([401, 403].includes(res.status), 'anonymous portal config write refused: ' + res.status);
      n++;
      group('Part 3 HTTP boot + route auth', n);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }

  console.log(`\nbatch158 reviews→social: PASS — ${groups.length} groups`);
})().catch((e) => {
  console.error('batch158 reviews→social: FAIL');
  console.error(e);
  process.exit(1);
});
