'use strict';
/**
 * Batch 190 — ANTI-REPEAT RULE (spec §4a, scoped to Ely's 2026-11-14
 * pick: variant waves + anti-repeat).
 *
 * The rule runs over VARIANT SELECTIONS (the per-site ledger of
 * delivered variants) — never through the fingerprint double-match
 * machinery, which is blind for workspace-1 staff builds. It is
 * enforced at domain.designDeliver (the MCP/REST choke point) on
 * FIRST delivery of a website job only:
 *   (a) HERO RULE — candidate hero variant == the most recent
 *       other-lead site's hero variant → repeat ("standard" counts:
 *       two consecutive all-standard builds repeat — the 1HP →
 *       Chefmom failure this rule exists to interrupt).
 *   (b) MIX RULE — candidate's non-empty (type → variant) pair set
 *       exactly equals any of the last 5 other-lead sites' → repeat.
 * A repeat is refused with ANTI_REPEAT unless the payload carries
 * layout_need — a genuine need (>= 12 non-space chars, not a
 * speed/convenience claim). A justified repeat proceeds, records
 * layout_need + anti_repeat facts on the job brief, and warns on
 * the delivery result.
 *
 *   Part 1 — source pins.
 *   Part 2 — helper matrix over a seeded websites table: every
 *     rule branch (hero fire/clear, mix fire inside/outside the
 *     5-site window, empty pair set, no-hero candidate, same-lead
 *     exclusion, justification stoplist/length/valid).
 *   Part 3 — end-to-end through domain.designDeliver: a forced
 *     all-standard repeat against a seeded recent site is REFUSED;
 *     the same delivery with a genuine layout_need PASSES and is
 *     recorded; a different hero variant passes clean; a
 *     re-delivery of an existing site is never blocked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b190-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch190', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 35).toString('base64');

let groups = 0;
function group(name, n) {
  groups += 1;
  console.log(`ok ${groups} - ${name} (${n} checks)`);
}

const pagesWith = (sections) => [{ slug: '/', title: 'Home', sections }];
const heroSec = (variant) =>
  Object.assign({ type: 'hero', content: { headline: 'H' } }, variant ? { variant } : {});
const sec = (type, variant) =>
  Object.assign({ type, content: {} }, variant ? { variant } : {});

(async () => {
  const antiRepeat = require(path.join(root, 'server/variantAntiRepeat.js'));

  /* ================================================================== */
  /* Part 1 — source pins                                                */
  /* ================================================================== */
  {
    let n = 0;
    const dom = read('server/domain.js');
    assert.ok(dom.includes("require('./variantAntiRepeat')"), 'designDeliver consults the anti-repeat module');
    assert.ok(dom.includes("siteErr('ANTI_REPEAT'"), 'designDeliver refuses with ANTI_REPEAT');
    assert.ok(dom.includes('anti_repeat'), 'designDeliver records justified repeats on the brief');
    const mcp = read('server/mcp.js');
    assert.ok(mcp.includes('ANTI-REPEAT (Batch 190)'), 'design.deliver tool description carries the rule');
    n += 4;
    group('Part 1 — source pins', n);
  }

  /* ================================================================== */
  /* Part 2 — helper matrix                                              */
  /* ================================================================== */
  {
    let n = 0;
    const Database = require(path.join(root, 'node_modules/better-sqlite3'));
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE websites (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, name TEXT, pages TEXT, updated_at TEXT DEFAULT (datetime(\'now\')))'
    );
    const seed = (leadId, name, pages, updatedAt) =>
      db
        .prepare('INSERT INTO websites (lead_id, name, pages, updated_at) VALUES (?, ?, ?, ?)')
        .run(leadId, name, JSON.stringify(pages), updatedAt);
    const check = (leadId, pages, layoutNeed) => antiRepeat.antiRepeatCheck(db, { leadId, pages, layoutNeed });

    // No other sites at all → clear.
    assert.equal(check(1, pagesWith([heroSec()])).repeat, null);
    n++;
    // Seed the most recent other-lead site: hero standard, no variants.
    seed(2, 'Recent Standard', pagesWith([heroSec(), sec('cta')]), '2026-11-14 09:00:00');
    // (a) all-standard candidate repeats the hero.
    let v = check(1, pagesWith([heroSec(), sec('cta')]));
    assert.ok(v.repeat && v.repeat.kind === 'hero' && v.repeat.heroVariant === 'standard', 'hero rule fires on standard/standard');
    assert.equal(v.justified, false);
    n += 2;
    // Justification matrix on the same repeat.
    assert.equal(check(1, pagesWith([heroSec()]), 'faster this way').justified, false, 'speed claim is not a need');
    assert.equal(check(1, pagesWith([heroSec()]), 'brand kit').justified, false, 'too short is not a need');
    v = check(1, pagesWith([heroSec()]), 'Client brand book mandates the centred hero');
    assert.equal(v.justified, true, 'a genuine need justifies');
    n += 3;
    // Different hero variant → hero rule clears (pair sets are empty on both sides too).
    assert.equal(check(1, pagesWith([heroSec('split')])).repeat, null, 'different hero clears');
    n++;
    // Candidate with no hero section: hero rule cannot fire.
    assert.equal(check(1, pagesWith([sec('cta')])).repeat, null, 'no hero section, no hero rule');
    n++;
    // Same-lead sites are excluded: seed lead 1's own site with split hero.
    seed(1, 'Own Site', pagesWith([heroSec('split')]), '2026-11-14 10:00:00');
    assert.equal(check(1, pagesWith([heroSec('split')])).repeat, null, 'own-lead site never counts');
    n++;
    // (b) MIX RULE: seed a site (not most recent) with a known mix.
    seed(3, 'Mix Site', pagesWith([heroSec('editorial'), sec('faq', 'cards'), sec('cta', 'row')]), '2026-11-13 09:00:00');
    // Make the mix site the most recent by adding a newer different-hero site after it:
    seed(4, 'Newer Plain', pagesWith([heroSec('corner')]), '2026-11-14 11:00:00');
    v = check(1, pagesWith([heroSec('showcase'), sec('faq', 'cards'), sec('cta', 'row')]));
    assert.equal(v.repeat, null, 'mix differs when hero/pairs differ');
    v = check(9, pagesWith([heroSec('editorial'), sec('faq', 'cards'), sec('cta', 'row')]));
    assert.ok(v.repeat && v.repeat.kind === 'mix' && v.repeat.mixEqual === true, 'exact mix repeats within the window');
    n += 2;
    // Window: push the mix site beyond the last 5 other-lead sites.
    for (let i = 0; i < 5; i++) {
      seed(20 + i, `Filler ${i}`, pagesWith([heroSec('showcase')]), `2026-11-14 12:0${i}:00`);
    }
    v = check(9, pagesWith([heroSec('editorial'), sec('faq', 'cards'), sec('cta', 'row')]));
    assert.equal(v.repeat, null, 'mix outside the 5-site window clears (hero editorial != latest showcase)');
    n++;
    // Empty pair set never fires the mix rule even against an all-standard recent site.
    seed(30, 'Fresh Standard', pagesWith([heroSec()]), '2026-11-14 13:00:00');
    v = check(9, pagesWith([heroSec('split')]));
    assert.equal(v.repeat, null, 'empty candidate pair set: no mix repeat');
    n++;
    db.close();
    group('Part 2 — helper matrix', n);
  }

  /* ================================================================== */
  /* Part 3 — end-to-end through domain.designDeliver                    */
  /* ================================================================== */
  {
    let n = 0;
    const platformDb = require(path.join(root, 'server/db.js'));
    await platformDb.migrate();
    const workspace = require(path.join(root, 'server/workspace.js'));
    const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
    const designJobs = require(path.join(root, 'src/designJobs.js'));
    const domain = require(path.join(root, 'server/domain.js'));
    const ua = await workspace.createUserWithWorkspace({
      email: 'a190@example.invalid',
      password: ['batch190', 'pass'].join('-'),
      name: 'A190',
      workspaceName: 'Batch190 WS',
    });
    const WS_ID = Number(ua.workspaceId);
    const db = openWorkspaceDb(WS_ID);
    designJobs.ensureTables(db);
    const theme = { primary: '#b3123f', secondary: '#1d1a16', bg: '#fffaf4', text: '#241d18' };
    const mkLead = (id, name) =>
      db.prepare('INSERT INTO leads (id, business_name, email, status) VALUES (?, ?, ?, ?)').run(id, name, `l${id}@example.invalid`, 'customer');
    // The "recent comparable build": lead 1902's site, all-standard.
    mkLead(1902, 'B190 Recent Bakery');
    const recentPages = pagesWith([
      { type: 'nav', content: { brand: 'B190 Recent Bakery' } },
      { type: 'hero', content: { headline: 'Recent cakes', subheadline: 'Baked lately.' } },
      { type: 'cta', content: { title: 'Order', button_text: 'Start', button_href: '#contact' } },
      { type: 'footer', content: { business_name: 'B190 Recent Bakery' } },
    ]);
    db.prepare('INSERT INTO websites (lead_id, name, status, pages, theme) VALUES (?, ?, ?, ?, ?)').run(
      1902,
      'B190 Recent Bakery',
      'draft',
      JSON.stringify(recentPages),
      JSON.stringify(theme)
    );
    mkLead(1901, 'B190 New Bakery');
    const payload = (extra) =>
      Object.assign(
        {
          name: 'B190 New Bakery',
          theme,
          pages: pagesWith([
            { type: 'nav', content: { brand: 'B190 New Bakery' } },
            { type: 'hero', content: { headline: 'New cakes', subheadline: 'Baked fresh.' } },
            { type: 'cta', content: { title: 'Order', button_text: 'Start', button_href: '#contact' } },
            { type: 'footer', content: { business_name: 'B190 New Bakery' } },
          ]),
        },
        extra || {}
      );
    // 1) Forced all-standard repeat → REFUSED with ANTI_REPEAT.
    const job1 = designJobs.createJob(db, { leadId: 1901, type: 'website', title: 'B190 repeat', instructions: 'Build it.' });
    await assert.rejects(
      () => domain.designDeliver(WS_ID, Number(job1.id), payload(), []),
      (e) => e.code === 'ANTI_REPEAT' && /website \d+/.test(e.message) && /layout_need/.test(e.message),
      'forced repeat refused, naming the site and the remedy'
    );
    n++;
    // Nothing was delivered for the refused job.
    const jobRow1 = db.prepare('SELECT website_id FROM design_jobs WHERE id = ?').get(Number(job1.id));
    assert.ok(!jobRow1.website_id, 'refused delivery materialized no website');
    n++;
    // 2) Same delivery + genuine layout_need → PASSES, recorded.
    const job2 = designJobs.createJob(db, { leadId: 1901, type: 'website', title: 'B190 justified', instructions: 'Build it.' });
    const row2 = await domain.designDeliver(
      WS_ID,
      Number(job2.id),
      payload({ layout_need: 'Client brand book mandates the classic centred hero for every location' }),
      []
    );
    assert.ok(row2 && row2.website_id, 'justified repeat delivers');
    assert.ok(
      (row2.warnings || []).some((w) => /Anti-repeat/.test(w)),
      'delivery result warns about the justified repeat'
    );
    const brief2 = JSON.parse(db.prepare('SELECT brief FROM design_jobs WHERE id = ?').get(Number(job2.id)).brief || '{}');
    assert.ok(brief2.layout_need && brief2.layout_need.includes('brand book'), 'brief records the need');
    assert.ok(brief2.anti_repeat && brief2.anti_repeat.justified === true && brief2.anti_repeat.heroVariant === 'standard', 'brief records the repeat facts');
    n += 4;
    // 3) A different hero variant passes clean against the same ledger.
    mkLead(1903, 'B190 Split Bakery');
    const job3 = designJobs.createJob(db, { leadId: 1903, type: 'website', title: 'B190 split', instructions: 'Build it.' });
    const p3 = payload();
    p3.name = 'B190 Split Bakery';
    p3.pages[0].sections[1].variant = 'split';
    const row3 = await domain.designDeliver(WS_ID, Number(job3.id), p3, []);
    assert.ok(row3 && row3.website_id, 'different hero variant delivers');
    assert.ok(!(row3.warnings || []).some((w) => /Anti-repeat/.test(w)), 'no anti-repeat warning on a clean delivery');
    n += 2;
    // 4) Re-delivery of an existing site is never blocked (job2's job
    // now has a website; delivering again with a standard hero whose
    // most recent other-lead neighbour is now split-hero lead 1903
    // would pass anyway — so also re-deliver job for lead 1903 with
    // a standard hero: most recent other-lead is 1901 standard, but
    // the job already has a website → exempt).
    const p4 = payload();
    p4.name = 'B190 Split Bakery';
    const row4 = await domain.designDeliver(WS_ID, Number(job3.id), p4, []);
    assert.ok(row4 && row4.website_id, 're-delivery of an existing site is exempt');
    n++;
    group('Part 3 — end-to-end designDeliver', n);
  }

  console.log(`\nbatch190: all ${groups} groups passed`);
})().catch((e) => {
  console.error('batch190 FAILED:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
