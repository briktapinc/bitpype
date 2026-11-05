'use strict';
/**
 * Batch 116 — EXTERNAL WEBSITE KIND FOR LEADS (Ely's order 2026-11-01,
 * from his screenshot of the staff "Build a website for a lead" card:
 * "We need to add if the website is external. i.e wordpress, trying to
 * add a lead for a wordpress site but cant").
 *
 * Root cause this batch fixes: the stack had NO website-kind concept.
 * normalizeToLead (src/providers.js) is a strict whitelist with no
 * kind field, the leads table carried only a free-text `website`
 * string, both MCP surfaces' lead picklists/schemas had no kind, and
 * every staff surface (Add lead modal, lead detail form + Website
 * section, the Websites-page build card) treated the build flow as
 * BitPype-only — a lead whose live site is a WordPress site could not
 * be declared, so the builders were the only story the UI could tell.
 *
 * Design: workspace-layer leads gain `website_kind`
 * ('bitpype' default | 'external') + `website_platform`
 * ('wordpress' | 'other', only with external). The external URL lives
 * in the existing `website` column (always "the lead's website URL";
 * the kind is the missing semantic). Validation funnels through
 * leadEngine.validateLeadInput: external REQUIRES a valid http(s)
 * URL; bitpype forces platform NULL. The flag NEVER creates, deletes
 * or unlinks a BitPype site — a lead can carry both facts; the flag
 * names the primary website home. REST passes through the engine;
 * hosted MCP dispatch passes through too (schemas gained the fields);
 * the desktop MCP picklists + leadSummary carry them.
 *
 * Part 1 — source pins (engine/schema/MCP/OpenAPI/UI surfaces,
 *   SEC-13 census byte-identical).
 * Part 2 — engine behaviour on real workspace stores: defaults,
 *   external round-trip, every validation rejection, kind switches
 *   both ways, partial-update preservation, the duplicate-email rule
 *   untouched, lean lead-finder creates untouched, and the lazy
 *   migration of a pre-116 database (schema text minus the Batch 116
 *   lines) via ensureLeadColumns.
 * Part 3 — HTTP over a bare express mount of the real domainApi
 *   router: create external → read → list → patch both ways → the
 *   no-URL rejection over the wire.
 *
 * NEGATIVE PROOF: B116_NEGATIVE=no-url asserts creating an external
 * lead WITHOUT a URL succeeds — it must go RED, proving the
 * URL-requirement assertions bite.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const NEGATIVE = process.env.B116_NEGATIVE || '';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b116-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'https://bitpype.test';
process.env.CAPTCHA_OPTIONAL = '1';
process.env.NODE_ENV = 'production';
process.env['SESSION_' + 'SECRET'] = ['batch116', 'test', 'session', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 43).toString('base64');

const groups = [];
function group(name, n) {
  groups.push(`${name} (${n})`);
  console.log(`  ok ${name} — ${n} checks`);
}
function has(src, needle, label) {
  assert.ok(src.includes(needle), `missing pin: ${label} — ${needle.slice(0, 90)}`);
}

(async () => {
  // ---------------------------------------------------------------
  // Part 1 — source pins
  {
    let n = 0;
    const schema = read('src/schema.sql');
    has(schema, "website_kind TEXT DEFAULT 'bitpype'", 'schema: website_kind column');
    n += 1;
    has(schema, 'website_platform TEXT', 'schema: website_platform column');
    n += 1;

    const engine = read('src/leadEngine.js');
    for (const needle of [
      "const WEBSITE_KINDS = ['bitpype', 'external']",
      "const WEBSITE_PLATFORMS = ['wordpress', 'other']",
      'function normalizeWebsiteKind(data, lead)',
      "ALTER TABLE leads ADD COLUMN website_kind TEXT NOT NULL DEFAULT 'bitpype'",
      'ALTER TABLE leads ADD COLUMN website_platform TEXT',
      'website_kind=@website_kind',
      "'a valid website URL is required for an external website'",
    ]) {
      has(engine, needle, `leadEngine: ${needle.slice(0, 50)}`);
      n += 1;
    }

    const serverMcp = read('server/mcp.js');
    has(serverMcp, 'website_kind', 'hosted MCP mentions website_kind');
    n += 1;
    has(serverMcp, "enum: ['bitpype', 'external']", 'hosted MCP lead.create kind enum');
    n += 1;
    has(serverMcp, "enum: ['wordpress', 'other']", 'hosted MCP lead.create platform enum');
    n += 1;

    const srcMcp = read('src/mcp.js');
    has(srcMcp, 'website_kind: args.website_kind', 'desktop MCP create payload carries kind');
    n += 1;
    has(srcMcp, "'website_kind',\n        'website_platform',", 'desktop MCP update picklist carries kind pair');
    n += 1;
    has(
      srcMcp,
      "website_kind: row.website_kind === 'external' ? 'external' : 'bitpype'",
      'desktop MCP leadSummary carries kind'
    );
    n += 1;

    const openapi = read('server/openapiV1.js');
    has(openapi, "website_kind: { type: 'string', enum: ['bitpype', 'external'] }", 'OpenAPI lead create kind');
    n += 1;
    has(openapi, "website_platform: { type: 'string', enum: ['wordpress', 'other'] }", 'OpenAPI lead create platform');
    n += 1;

    const domain = read('server/domain.js');
    has(
      domain,
      "website_kind: r.website_kind === 'external' ? 'external' : 'bitpype'",
      'domain list read-normalization'
    );
    n += 1;

    const app = read('public/js/app.js');
    // Add-lead modal + lead detail form carry the selects.
    assert.ok(
      (app.match(/name="website_kind"/g) || []).length >= 2,
      'app.js: website_kind select in add modal AND detail form'
    );
    n += 1;
    assert.ok(
      (app.match(/name="website_platform"/g) || []).length >= 2,
      'app.js: website_platform select in add modal AND detail form'
    );
    n += 1;
    // Build card: kind select, both panes, save actions, builder guard.
    for (const needle of [
      'id="w-kind"',
      'id="w-bitpype-pane"',
      'id="w-external-pane" hidden',
      'id="w-ext-url"',
      'id="w-ext-platform"',
      'data-act="ext-save"',
      'data-act="kind-save"',
      'id="w-switch-hint" hidden',
      'function syncKindCard(lead)',
      "This lead's website is external — switch its home to BitPype to build here.",
      'External site · ',
      '· external</span>',
    ]) {
      has(app, needle, `app.js build card/detail/list: ${needle.slice(0, 50)}`);
      n += 1;
    }
    has(read('public/index.html'), '/js/app.js?v=batch123-openrouter1', 'app.js cache-bust bumped');
    n += 1;

    // SEC-13 census: Batch 124 moved the multiset deliberately —
    // five new reviewed sinks (categories scopes panel + embed
    // branches; multiset diff proven to contain nothing else).
    const { census } = require(path.join(root, 'scripts', 'xss-census.cjs'));
    const cz = census();
    assert.deepEqual(
      cz.summary,
      { total: 448, STATIC: 162, ESCAPED: 41, SAFE: 73, BUILDER: 59, IDENT: 36, RAW: 77 },
      'SEC-13 census summary unchanged'
    );
    n += 1;
    const multiset = cz.sinks.map((s) => `${s.file}|${s.kind}|${s.snippet}`).sort();
    const sha = crypto.createHash('sha256').update(multiset.join('\n')).digest('hex');
    assert.equal(
      sha,
      'a3fdd0d2828bda5f285652714975ba4010db4c1cc0eeadf2c89ddd071bc40040',
      'SEC-13 sink multiset byte-identical (Batch 136 finisher: +2 audited STATIC sinks in module-embed.js; RAW/IDENT multiset unchanged)'
    );
    n += 1;

    group('Part 1 — source pins + SEC-13 census', n);
  }

  // ---------------------------------------------------------------
  // Part 2 — engine behaviour on real workspace stores
  {
    let n = 0;
    const domain = require(path.join(root, 'server/domain.js'));
    const engine = require(path.join(root, 'src/leadEngine.js'));
    const WS = 1;

    // Lean lead-finder create (the crons' exact field shape) is
    // untouched: defaults bitpype / null.
    const lean = domain.leadsCreate(WS, {
      business_name: 'Lean Finder Lead',
      category: 'plumber',
      phone: '+16105550101',
      city: 'Reading',
      notes: 'cron-shaped create',
    });
    assert.equal(lean.website_kind, 'bitpype');
    assert.equal(lean.website_platform, null);
    n += 2;

    // Plain create with a website but no kind: still BitPype home.
    const plain = domain.leadsCreate(WS, {
      business_name: 'Plain Site Lead',
      email: 'plain@example.test',
      website: 'https://plain.example.com',
    });
    assert.equal(plain.website_kind, 'bitpype');
    assert.equal(plain.website_platform, null);
    n += 2;

    // A platform passed with the BitPype kind is normalized away.
    const stray = domain.leadsCreate(WS, {
      business_name: 'Stray Platform Lead',
      website_platform: 'wordpress',
    });
    assert.equal(stray.website_kind, 'bitpype');
    assert.equal(stray.website_platform, null);
    n += 2;

    // External WordPress round-trip.
    const ext = domain.leadsCreate(WS, {
      business_name: 'WP Lead',
      email: 'wp@example.test',
      website: 'https://wp-lead.example.com',
      website_kind: 'external',
      website_platform: 'wordpress',
    });
    assert.equal(ext.website_kind, 'external');
    assert.equal(ext.website_platform, 'wordpress');
    assert.equal(ext.website, 'https://wp-lead.example.com');
    n += 3;
    const extGet = domain.leadsGet(WS, ext.id).lead;
    assert.equal(extGet.website_kind, 'external');
    assert.equal(extGet.website_platform, 'wordpress');
    n += 2;

    // External without a platform defaults to 'other'.
    const extOther = domain.leadsCreate(WS, {
      business_name: 'Squarespace Lead',
      website: 'https://sq.example.com',
      website_kind: 'external',
    });
    assert.equal(extOther.website_kind, 'external');
    assert.equal(extOther.website_platform, 'other');
    n += 2;

    // Rejections.
    const rejects = [
      [{ business_name: 'No URL', website_kind: 'external', website_platform: 'wordpress' }, /website URL is required/],
      [
        { business_name: 'Bad URL', website_kind: 'external', website: 'notaurl' },
        /invalid website URL|website URL is required/,
      ],
      [{ business_name: 'Bad Kind', website_kind: 'wix', website: 'https://x.example.com' }, /invalid website_kind/],
      [
        {
          business_name: 'Bad Platform',
          website_kind: 'external',
          website_platform: 'wix',
          website: 'https://x.example.com',
        },
        /invalid website_platform/,
      ],
    ];
    for (const [payload, re] of rejects) {
      if (NEGATIVE === 'no-url' && payload.business_name === 'No URL') {
        // Negative mode asserts the OPPOSITE (creation succeeds) —
        // against correct code this goes red, proving the bite.
        assert.doesNotThrow(
          () => domain.leadsCreate(WS, payload),
          'negative mode: external without URL must be creatable'
        );
        n += 1;
        continue;
      }
      assert.throws(() => domain.leadsCreate(WS, payload), re, `create should reject: ${payload.business_name}`);
      n += 1;
    }

    // Switch bitpype -> external using the URL already on the lead.
    const switched = domain.leadsUpdate(WS, plain.id, { website_kind: 'external', website_platform: 'wordpress' });
    assert.equal(switched.website_kind, 'external');
    assert.equal(switched.website_platform, 'wordpress');
    assert.equal(switched.website, 'https://plain.example.com');
    n += 3;

    // Partial update preserves the kind pair.
    const noted = domain.leadsUpdate(WS, plain.id, { notes: 'still external' });
    assert.equal(noted.website_kind, 'external');
    assert.equal(noted.website_platform, 'wordpress');
    n += 2;

    // Clearing the URL under an external lead is rejected.
    assert.throws(() => domain.leadsUpdate(WS, plain.id, { website: '' }), /website URL is required/);
    n += 1;

    // Switch external -> bitpype: platform nulls, the URL stays on the
    // record as data, and no website rows are touched (none exist —
    // the flag must not manufacture or destroy any).
    const back = domain.leadsUpdate(WS, plain.id, { website_kind: 'bitpype' });
    assert.equal(back.website_kind, 'bitpype');
    assert.equal(back.website_platform, null);
    assert.equal(back.website, 'https://plain.example.com');
    n += 3;

    // The duplicate-email rule is untouched by the kind fields.
    assert.throws(
      () => domain.leadsCreate(WS, { business_name: 'Dupe', email: 'wp@example.test' }),
      /already belongs|already exists|DUPLICATE/i
    );
    n += 1;
    assert.throws(
      () => domain.leadsUpdate(WS, lean.id, { email: 'wp@example.test' }),
      /already belongs|already exists|DUPLICATE/i
    );
    n += 1;

    // List rows expose the normalized pair.
    const list = domain.leadsList(WS, { q: 'WP Lead' });
    const row = (list.leads || list.rows || []).find((l) => l.id === ext.id);
    assert.ok(row, 'list contains the WP lead');
    assert.equal(row.website_kind, 'external');
    assert.equal(row.website_platform, 'wordpress');
    n += 3;

    // Lazy migration: a pre-116 database (current schema text minus
    // the two Batch 116 column lines) gains the columns through the
    // engine's ensure path, and a legacy row reads back as bitpype.
    const Database = require('better-sqlite3');
    const oldDbPath = path.join(temp, 'legacy-workspace.sqlite');
    const oldDb = new Database(oldDbPath);
    const legacySchema = read('src/schema.sql')
      .split('\n')
      .filter((line) => !line.includes('website_kind') && !line.includes('website_platform'))
      .join('\n');
    oldDb.exec(legacySchema);
    oldDb
      .prepare(
        "INSERT INTO leads (business_name, email, website) VALUES ('Legacy Biz', 'legacy@example.test', 'https://legacy.example.com')"
      )
      .run();
    const legacyBefore = engine.getLead(oldDb, 1);
    assert.equal(legacyBefore.website_kind, 'bitpype', 'legacy row normalizes to bitpype on read');
    assert.equal(legacyBefore.website_platform, null);
    n += 2;
    const createdOnLegacy = engine.createLead(oldDb, {
      business_name: 'Legacy WP',
      website: 'https://legacy-wp.example.com',
      website_kind: 'external',
      website_platform: 'wordpress',
    });
    assert.equal(createdOnLegacy.website_kind, 'external');
    const cols = oldDb
      .prepare('PRAGMA table_info(leads)')
      .all()
      .map((c) => c.name);
    assert.ok(
      cols.includes('website_kind') && cols.includes('website_platform'),
      'ensureLeadColumns added both columns'
    );
    n += 2;
    oldDb.close();

    group('Part 2 — engine behaviour + lazy migration', n);
  }

  // ---------------------------------------------------------------
  // Part 3 — HTTP over the real domainApi router
  {
    let n = 0;
    const express = require('express');
    const router = require(path.join(root, 'server/routes/domainApi.js'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = { via: 'session', userId: 999, workspaceId: 2, role: 'owner', leadId: null };
      next();
    });
    app.use(router);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, body) =>
      fetch(base + p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
      });
    try {
      const createRes = await call('POST', '/leads', {
        business_name: 'HTTP WP Lead',
        email: 'http-wp@example.test',
        website: 'https://http-wp.example.com',
        website_kind: 'external',
        website_platform: 'wordpress',
      });
      assert.equal(createRes.status, 200);
      const created = (await createRes.json()).data.lead;
      assert.equal(created.website_kind, 'external');
      assert.equal(created.website_platform, 'wordpress');
      n += 3;

      const getRes = await call('GET', `/leads/${created.id}`);
      assert.equal(getRes.status, 200);
      assert.equal((await getRes.json()).data.lead.website_kind, 'external');
      n += 2;

      const patchRes = await call('PATCH', `/leads/${created.id}`, { website_kind: 'bitpype' });
      assert.equal(patchRes.status, 200);
      const patched = (await patchRes.json()).data.lead;
      assert.equal(patched.website_kind, 'bitpype');
      assert.equal(patched.website_platform, null);
      n += 3;

      const badRes = await call('POST', '/leads', {
        business_name: 'HTTP No URL',
        website_kind: 'external',
        website_platform: 'wordpress',
      });
      assert.equal(badRes.status, 400);
      const badBody = await badRes.json();
      assert.ok(JSON.stringify(badBody).includes('website'), 'rejection names the website requirement');
      n += 2;
    } finally {
      server.close();
    }
    group('Part 3 — HTTP lifecycle over domainApi', n);
  }

  console.log(`BATCH116 REGRESSIONS PASS — ${groups.length} groups: ${groups.join(' · ')}`);
})().catch((e) => {
  console.error('BATCH116 REGRESSIONS FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
