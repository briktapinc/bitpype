'use strict';
/**
 * Batch 106 — AI spend provider tracking.
 *
 * Every AI call was already logged to ai_usage (task, model, tokens,
 * estimated cost) but nothing recorded WHICH API served the call.
 * This batch adds ai_usage.provider:
 *   - schema: column added to all three schema files; existing
 *     workspace DBs gain it via the open-time ensure in
 *     workspaceDb.js (central DBs via db.js migrate()), idempotent.
 *   - logging: every INSERT site records the provider that actually
 *     served the call — src/ai.js and src/openaiImages.js derive it
 *     from the base URL the call was sent to, server/museAgent.js
 *     from its configured base URL, src/socialMedia.js threads the
 *     serving provider through generateImages' return.
 *   - backfill: rows that predate the column are attributed from
 *     the model name ONLY where unambiguous (muse-* → muse,
 *     OpenAI families → openai, fal-ai/* → fal); the rest stay
 *     'unknown'. The backfill runs only when the column is first
 *     added, so a later-logged 'unknown' row is never rewritten.
 *   - finance: aiSpend gains byProvider + byProviderTask; the
 *     summary attaches both; aiUsageByWorkspace rows + totals gain
 *     the provider split. A DB without the column still reads —
 *     everything attributes to 'unknown'.
 *
 * NEGATIVE PROOF: B106_NEGATIVE=provider strips `provider` back out
 * of the src/ai.js INSERT on disk before the checks run (restored
 * in a finally); the insert-site pin and the functional attribution
 * checks then fail — the attribution is load-bearing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b106-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.WS_DB_PATH = path.join(temp, 'ws', 'websitescout.db');
process.env.APP_URL = 'https://bitpype.test';
process.env.NODE_ENV = 'production';
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const NEGATIVE = process.env.B106_NEGATIVE === 'provider';

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
const asyncChecks = [];
function acheck(name, fn) {
  asyncChecks.push([name, fn]);
}
function group(label, n) {
  console.log(`OK batch106 ${label} (${n} checks)`);
}

const Database = require('better-sqlite3');
const aiProvider = require(path.join(root, 'src/aiProvider.js'));
const finance = require(path.join(root, 'server/finance.js'));
const OCT = { from: '2026-10-01', to: '2026-10-31' };

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function schemaDb() {
  const db = new Database(':memory:');
  db.exec(read('src/schema.sql'));
  return db;
}
function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ---------------------------------------------------------------------
// Negative hook: strip provider from the src/ai.js INSERT on disk.
// ---------------------------------------------------------------------
const aiPath = path.join(root, 'src/ai.js');
let aiBackup = null;
if (NEGATIVE) {
  aiBackup = fs.readFileSync(aiPath, 'utf8');
  const stripped = aiBackup.replace(
    'INSERT INTO ai_usage (task, provider, model',
    'INSERT INTO ai_usage (task, model'
  );
  assert.notEqual(stripped, aiBackup, 'negative hook must change src/ai.js');
  fs.writeFileSync(aiPath, stripped);
}

(async () => {
  try {
    // ---------------- provider derivation units ----------------
    let n = 0;
    const fromUrl = aiProvider.providerFromBaseUrl;
    const fromModel = aiProvider.providerFromModel;
    check('baseUrl api.openai.com → openai', () => assert.equal(fromUrl('https://api.openai.com/v1'), 'openai'));
    check('baseUrl api.meta.ai → muse', () => assert.equal(fromUrl('https://api.meta.ai/v1'), 'muse'));
    check('baseUrl queue.fal.run → fal', () => assert.equal(fromUrl('https://queue.fal.run/fal-ai/x'), 'fal'));
    check('baseUrl fal.run → fal', () => assert.equal(fromUrl('https://fal.run/fal-ai/x'), 'fal'));
    check('baseUrl api.anthropic.com → anthropic', () => assert.equal(fromUrl('https://api.anthropic.com/v1'), 'anthropic'));
    check('baseUrl api.deepseek.com → deepseek (host slug)', () => assert.equal(fromUrl('https://api.deepseek.com/v1'), 'deepseek'));
    check('baseUrl openrouter.ai → openrouter', () => assert.equal(fromUrl('https://openrouter.ai/api/v1'), 'openrouter'));
    check('baseUrl localhost → local', () => assert.equal(fromUrl('http://127.0.0.1:11434/v1'), 'local'));
    check('baseUrl garbage → unknown', () => assert.equal(fromUrl('not a url'), 'unknown'));
    check('baseUrl empty → unknown', () => assert.equal(fromUrl(''), 'unknown'));
    n += 10;
    check('model muse-spark-1.3 → muse', () => assert.equal(fromModel('muse-spark-1.3'), 'muse'));
    check('model gpt-4o-mini → openai', () => assert.equal(fromModel('gpt-4o-mini'), 'openai'));
    check('model gpt-image-2.5-sunburst → openai', () => assert.equal(fromModel('gpt-image-2.5-sunburst'), 'openai'));
    check('model dall-e-3 → openai', () => assert.equal(fromModel('dall-e-3'), 'openai'));
    check('model text-embedding-3-small → openai', () => assert.equal(fromModel('text-embedding-3-small'), 'openai'));
    check('model o3-mini → openai', () => assert.equal(fromModel('o3-mini'), 'openai'));
    check('model fal-ai/nano-banana-pro/edit → fal', () => assert.equal(fromModel('fal-ai/nano-banana-pro/edit'), 'fal'));
    check('model claude-sonnet-4 → unknown (ambiguous route)', () => assert.equal(fromModel('claude-sonnet-4'), 'unknown'));
    check('model llama-3.1-70b → unknown', () => assert.equal(fromModel('llama-3.1-70b'), 'unknown'));
    check('model empty → unknown', () => assert.equal(fromModel(''), 'unknown'));
    n += 10;
    group('provider derivation', n);

    // ---------------- migration + backfill ----------------
    n = 0;
    const legacy = new Database(':memory:');
    legacy.exec(`CREATE TABLE ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL, model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0, lead_id INTEGER, note TEXT,
      at TEXT DEFAULT (datetime('now')));`);
    const ins = legacy.prepare(
      'INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run('portal_agent', 'muse-spark-1.3', 10, 5, 0.01);
    ins.run('research', 'gpt-4o-mini', 10, 5, 0.01);
    ins.run('image', 'gpt-image-2.5-sunburst', 0, 5, 0.04);
    ins.run('image', 'dall-e-3', 0, 0, 0.04);
    ins.run('qa', 'claude-3-5-sonnet', 10, 5, 0.01);
    ins.run('social_branded_image', 'fal-ai/nano-banana-pro/edit', 0, 0, 1);
    const first = aiProvider.ensureAiUsageProvider(legacy);
    check('ensure adds the column on a legacy DB', () => assert.equal(first.added, true));
    check('backfill counts by outcome', () =>
      assert.deepEqual(first.backfill, { total: 6, byProvider: { muse: 1, openai: 3, fal: 1, unknown: 1 } }));
    check('backfill wrote the rows', () => {
      const rows = legacy.prepare('SELECT model, provider FROM ai_usage ORDER BY id').all();
      assert.deepEqual(
        rows.map((r) => r.provider),
        ['muse', 'openai', 'openai', 'openai', 'unknown', 'fal']
      );
    });
    const second = aiProvider.ensureAiUsageProvider(legacy);
    check('ensure is idempotent (second run adds nothing, backfills nothing)', () => {
      assert.equal(second.added, false);
      assert.equal(second.backfill, null);
    });
    check('a post-tracking unknown row is never flipped by a later ensure', () => {
      legacy
        .prepare("INSERT INTO ai_usage (task, provider, model, cost_usd) VALUES ('research', 'unknown', 'gpt-4o', 0.01)")
        .run();
      aiProvider.ensureAiUsageProvider(legacy);
      const row = legacy.prepare("SELECT provider FROM ai_usage WHERE model = 'gpt-4o'").get();
      assert.equal(row.provider, 'unknown');
    });
    check('column default is unknown for un-attributed inserts', () => {
      legacy.prepare("INSERT INTO ai_usage (task, model, cost_usd) VALUES ('qa', 'whatever-1', 0)").run();
      const row = legacy.prepare("SELECT provider FROM ai_usage WHERE model = 'whatever-1'").get();
      assert.equal(row.provider, 'unknown');
    });
    n += 6;
    check('new workspace schema carries provider', () => {
      const db = schemaDb();
      const cols = db.prepare('PRAGMA table_info(ai_usage)').all().map((c) => c.name);
      assert.ok(cols.includes('provider'));
      db.close();
    });
    check('central sqlite + mysql schemas carry provider', () => {
      assert.match(read('sql/schema.sqlite.sql'), /CREATE TABLE IF NOT EXISTS ai_usage \([\s\S]{0,400}?provider TEXT NOT NULL DEFAULT 'unknown'/);
      assert.match(read('sql/schema.sql'), /CREATE TABLE IF NOT EXISTS ai_usage \([\s\S]{0,400}?provider VARCHAR\(40\) NOT NULL DEFAULT 'unknown'/);
    });
    check('workspace open path ensures the column', () =>
      assert.ok(read('server/workspaceDb.js').includes('ensureAiUsageProvider')));
    check('central migrate() ensures the column (both drivers)', () => {
      const dbjs = read('server/db.js');
      assert.ok(dbjs.includes('ensureAiUsageProvider'), 'sqlite branch');
      assert.ok(dbjs.includes("ADD COLUMN `provider` VARCHAR(40) NOT NULL DEFAULT 'unknown'"), 'mysql branch');
    });
    n += 4;
    group('migration + backfill', n);

    // ---------------- insert-site pins ----------------
    n = 0;
    check('src/ai.js INSERT records provider from the base URL used', () => {
      const src = read('src/ai.js');
      assert.ok(src.includes('INSERT INTO ai_usage (task, provider, model'), 'insert lists provider');
      // Batch 120: with per-function routing + failover, the serving
      // attempt's profile base URL is what counts.
      assert.ok(src.includes('providerFromBaseUrl(served.profile.baseUrl)'), 'derived from the base URL of the attempt that served the call');
    });
    check('museAgent logUsage + all call sites record provider', () => {
      const src = require('./lib/monolithSource.cjs').museAgentSource();
      assert.ok(src.includes('INSERT INTO ai_usage (task, provider, model'), 'insert lists provider');
      // Batch 120: call sites pass servedProviderFor(config) — the
      // provider that ACTUALLY served the routed call (it falls back
      // to providerForConfig when nothing has been served yet).
      const sites = src.match(/provider: servedProviderFor\(config\)/g) || [];
      assert.equal(sites.length, 4, 'four logUsage call sites pass the served provider');
      assert.ok(src.includes('providerFromBaseUrl(config && config.baseUrl)'), 'derived from the configured base URL');
    });
    check('openaiImages INSERT records provider and returns it', () => {
      const src = read('src/openaiImages.js');
      assert.ok(src.includes('INSERT INTO ai_usage (task, provider, model'), 'insert lists provider');
      assert.ok(src.includes('providerFromBaseUrl(baseUrl)'), 'derived from the base URL used');
      assert.ok(src.includes('return { model, provider,'), 'provider threaded into the return');
    });
    check('socialMedia INSERT records the serving provider', () => {
      const src = read('src/socialMedia.js');
      assert.ok(src.includes('INSERT INTO ai_usage (task, provider, model'), 'insert lists provider');
      assert.ok(src.includes('result.provider ||'), 'threads the generateImages provider');
    });
    check('every ai_usage INSERT in the tree records provider', () => {
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === 'archive') continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) files.push(p);
        }
      };
      walk(path.join(root, 'src'));
      walk(path.join(root, 'server'));
      const inserts = [];
      for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/INSERT INTO ai_usage \(([^)]*)\)/g)) inserts.push([path.relative(root, f), m[1]]);
      }
      assert.equal(inserts.length, 4, `expected exactly 4 insert sites, found ${inserts.length}`);
      for (const [f, cols] of inserts) assert.ok(cols.includes('provider'), `${f} insert must list provider`);
    });
    n += 5;
    group('insert-site pins', n);

    // ---------------- functional logging ----------------
    const urlSafety = require(path.join(root, 'server/urlSafety.js'));
    const origAssert = urlSafety.assertAiBaseUrl;
    urlSafety.assertAiBaseUrl = async () => {};
    const origFetch = global.fetch;
    const TINY_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    try {
      const db = schemaDb();
      setSetting(db, 'ai.api_key', 'sk-b106-fixture');
      setSetting(db, 'cost.daily_budget_usd', '0');
      setSetting(db, 'ai.base_url', 'https://api.openai.com/v1');
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'fixture reply' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
      });
      const ai = require(path.join(root, 'src/ai.js'));
      acheck('ai.chat via an OpenAI base URL logs provider=openai', async () => {
        const out = await ai.chat({ task: 'research', messages: [{ role: 'user', content: 'hi' }], db });
        assert.equal(out.provider, 'openai');
        const row = db.prepare("SELECT provider, task FROM ai_usage WHERE task = 'research'").get();
        assert.deepEqual(row, { provider: 'openai', task: 'research' });
      });
      acheck('ai.chat via a Meta base URL logs provider=muse', async () => {
        setSetting(db, 'ai.base_url', 'https://api.meta.ai/v1');
        setSetting(db, 'ai.model.default', 'muse-spark-1.3');
        const out = await ai.chat({ task: 'generation', messages: [{ role: 'user', content: 'hi' }], db });
        assert.equal(out.provider, 'muse');
        const row = db.prepare("SELECT provider FROM ai_usage WHERE task = 'generation'").get();
        assert.equal(row.provider, 'muse');
      });
      acheck('openaiImages logs provider=openai and returns it', async () => {
        setSetting(db, 'ai.base_url', 'https://api.openai.com/v1');
        global.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ b64_json: TINY_PNG }], usage: { input_tokens: 10, output_tokens: 100 } }),
        });
        const openaiImages = require(path.join(root, 'src/openaiImages.js'));
        const res = await openaiImages.generateImages(db, 'a fixture cat', { n: 1 });
        assert.equal(res.provider, 'openai');
        const row = db.prepare("SELECT provider FROM ai_usage WHERE task = 'image'").get();
        assert.equal(row.provider, 'openai');
      });
      for (const [name, fn] of asyncChecks) {
        await fn();
        results.push(name);
      }
      group('functional logging', asyncChecks.length);
    } finally {
      urlSafety.assertAiBaseUrl = origAssert;
      global.fetch = origFetch;
    }

    // ---------------- finance views ----------------
    n = 0;
    const fdb = schemaDb();
    finance.ensureTables(fdb);
    const fins = fdb.prepare(
      'INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    fins.run('portal_agent', 'muse', 'muse-spark-1.3', 100, 50, 1.5, '2026-10-15 10:00:00');
    fins.run('portal_agent', 'muse', 'muse-spark-1.3', 100, 50, 0.5, '2026-10-16 10:00:00');
    fins.run('image', 'openai', 'gpt-image-2.5-sunburst', 0, 100, 2.0, '2026-10-15 11:00:00');
    fins.run('research', 'openai', 'gpt-4o-mini', 200, 100, 0.25, '2026-10-15 12:00:00');
    fins.run('image', 'fal', 'fal-ai/nano-banana-pro/edit', 0, 0, 0.75, '2026-10-17 09:00:00');
    fins.run('qa', 'unknown', 'claude-3-5-sonnet', 10, 5, 0.1, '2026-10-18 09:00:00');
    fins.run('portal_agent', 'muse', 'muse-spark-1.3', 1, 1, 9.99, '2026-09-15 09:00:00');
    // aiSpend itself is internal to finance.js; its output surfaces
    // on summary().categories.ai — assert there.
    const spend = finance.summary(fdb, OCT).categories.ai;
    check('summary AI category carries byProvider totals for the period', () =>
      assert.deepEqual(spend.byProvider, [
        { key: 'openai', cents: 225, calls: 2 },
        { key: 'muse', cents: 200, calls: 2 },
        { key: 'fal', cents: 75, calls: 1 },
        { key: 'unknown', cents: 10, calls: 1 },
      ]));
    check('summary AI category carries the provider × task breakdown', () => {
      const got = spend.byProviderTask.map((r) => [r.provider, r.task, r.cents, r.calls]);
      assert.deepEqual(got, [
        ['fal', 'image', 75, 1],
        ['muse', 'portal_agent', 200, 2],
        ['openai', 'image', 200, 1],
        ['openai', 'research', 25, 1],
        ['unknown', 'qa', 10, 1],
      ]);
    });
    check('byTask / byModel output unchanged in shape', () => {
      assert.ok(Array.isArray(spend.byTask) && spend.byTask.every((r) => 'key' in r && 'cents' in r && 'calls' in r));
      assert.ok(Array.isArray(spend.byModel) && spend.byModel.every((r) => 'key' in r && 'cents' in r && 'calls' in r));
      assert.equal(spend.calls, 6, 'out-of-period row excluded');
    });
    n += 3;
    const fdb2 = schemaDb();
    finance.ensureTables(fdb2);
    const fins2 = fdb2.prepare(
      'INSERT INTO ai_usage (task, provider, model, prompt_tokens, completion_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    fins2.run('portal_agent', 'muse', 'muse-spark-1.3', 10, 5, 3.0, '2026-10-15 10:00:00');
    fins2.run('image', 'openai', 'gpt-image-2.5-sunburst', 0, 5, 1.0, '2026-10-15 10:00:00');
    check('aiUsageByWorkspace rows + totals carry the provider split', () => {
      const out = finance.aiUsageByWorkspace(OCT, [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }], (id) =>
        id === 1 ? fdb : fdb2
      );
      const two = out.rows.find((r) => r.workspaceId === 2);
      assert.deepEqual(two.byProvider, [
        { key: 'muse', cents: 300, calls: 1 },
        { key: 'openai', cents: 100, calls: 1 },
      ]);
      const tot = Object.fromEntries(out.totals.byProvider.map((p) => [p.key, p.cents]));
      assert.deepEqual(tot, { openai: 325, muse: 500, fal: 75, unknown: 10 });
    });
    check('a pre-migration DB (no provider column) still reads as all-unknown', () => {
      const ldb = new Database(':memory:');
      ldb.exec(`CREATE TABLE ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0, lead_id INTEGER, note TEXT, at TEXT DEFAULT (datetime('now')));`);
      finance.ensureTables(ldb);
      ldb.prepare("INSERT INTO ai_usage (task, model, cost_usd, at) VALUES ('qa', 'gpt-4o', 0.42, '2026-10-15 10:00:00')").run();
      const s = finance.summary(ldb, OCT).categories.ai;
      assert.deepEqual(s.byProvider, [{ key: 'unknown', cents: 42, calls: 1 }]);
      assert.deepEqual(s.byProviderTask, [{ provider: 'unknown', task: 'qa', cents: 42, calls: 1 }]);
      ldb.close();
    });
    n += 2;
    group('finance views', n);

    // ---------------- SEC-13 census pins ----------------
    n = 0;
    check('SEC-13 census unchanged by Batch 106 (totals + baseline)', () => {
      const { census } = require(path.join(root, 'scripts/xss-census.cjs'));
      const cz = census();
      assert.equal(cz.summary.total, 412, 'sink census total pinned');
      assert.equal(cz.summary.ESCAPED + cz.summary.SAFE + cz.summary.STATIC + cz.summary.BUILDER, 306, 'safe classes pinned');
      const reviewed = new Set(
        cz.sinks.filter((s) => s.kind === 'RAW' || s.kind === 'IDENT').map((s) => `${s.file}:${s.line}`)
      );
      assert.equal(reviewed.size, 106, 'reviewed set size pinned');
      const BASELINE = new Set(require(path.join(root, 'tests/batch103-xss-baseline.json')));
      assert.deepEqual([...reviewed].filter((x) => !BASELINE.has(x)), [], 'no new raw sinks');
      assert.deepEqual([...BASELINE].filter((x) => !reviewed.has(x)), [], 'baseline matches the reviewed set');
    });
    n += 1;
    group('SEC-13 census', n);

    console.log(JSON.stringify({ suite: 'batch106-provider-tracking', checks: results.length, passed: true }));
  } finally {
    if (aiBackup != null) fs.writeFileSync(aiPath, aiBackup);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  if (aiBackup != null) {
    try {
      fs.writeFileSync(aiPath, aiBackup);
    } catch {
      /* */
    }
  }
  console.error('batch106 FAIL:', e && e.message);
  process.exit(1);
});
