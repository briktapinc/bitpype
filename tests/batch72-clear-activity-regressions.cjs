'use strict';
/**
 * Batch 72 — "Clear all" for Recent Activity (Dashboard + Analytics).
 *
 * Ely's ask (2026-10-29): add clear-all to the Recent activity panel.
 * Both panels render the workspace `activity_log` (Dashboard via
 * api.activity, Analytics via the dashboard payload), so one facade
 * serves both:
 *
 *   - domain.adminClearActivity(ws, {confirm}) — same CONFIRM_REQUIRED
 *     gate as the Batch 51 clear-alls (literal 'DELETE'), deletes ALL
 *     rows from the CALLER's workspace log only, returns the exact
 *     count. Deliberately NOT runClearAll: that helper writes a summary
 *     row into activity_log, which would instantly refill the panel.
 *   - Route POST /admin-area/activity/clear-all — owner/admin session
 *     role, lead-scoped tokens denied (the Batch 51 guard chain). The
 *     clear's durable record is a PLATFORM audit entry
 *     ('activity.clear', actor + workspaceId + deleted count), never
 *     an activity_log row.
 *   - UI: "Clear all…" button in the panel header on BOTH pages,
 *     rendered only when the panel has rows; the shared
 *     runClearActivityFlow states the real total (from the activity
 *     endpoint's page total, not the visible rows) + "cannot be
 *     undone", then the Batch 45 type-DELETE prompt.
 *
 * Harness: facade tests on temp on-disk workspaces (openWorkspaceDb —
 * ws1 AND ws2, so cross-workspace survival is proven against real
 * separate stores) + an in-process mount of the real domainApi router
 * for the route/audit/role checks + source-shape wiring checks.
 * Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b72-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.APP_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = 'batch72-test-session-secret';
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString('base64');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
async function checkAsync(name, fn) {
  await fn();
  results.push(name);
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected code ${code}, got ${e.code || e.message}`);
    return e;
  }
  assert.fail(`expected throw with code ${code}`);
}

const { openWorkspaceDb } = require(path.join(root, 'server/workspaceDb.js'));
const domain = require(path.join(root, 'server/domain.js'));
const platformDb = require(path.join(root, 'server/db.js'));

const wdb1 = openWorkspaceDb(1);
const wdb2 = openWorkspaceDb(2);
const count = (db) => db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c;
const seed = (db, n, tag) => {
  const ins = db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)');
  for (let i = 0; i < n; i++) ins.run('test', `${tag} entry ${i + 1}`);
};

function testFacade() {
  seed(wdb1, 5, 'ws1');
  seed(wdb2, 3, 'ws2');

  check('A1 clear without confirm=DELETE is refused and deletes nothing', () => {
    throwsCode(() => domain.adminClearActivity(1, {}), 'CONFIRM_REQUIRED');
    throwsCode(() => domain.adminClearActivity(1, { confirm: 'delete' }), 'CONFIRM_REQUIRED');
    throwsCode(() => domain.adminClearActivity(1), 'CONFIRM_REQUIRED');
    assert.equal(count(wdb1), 5);
    assert.equal(count(wdb2), 3);
  });

  check('A2 clear deletes the whole caller workspace log and returns the exact count', () => {
    const out = domain.adminClearActivity(1, { confirm: 'DELETE' });
    assert.equal(out.deleted, 5);
    assert.equal(count(wdb1), 0);
  });

  check("A3 the other workspace's log survives untouched", () => {
    assert.equal(count(wdb2), 3);
    const rows = wdb2.prepare('SELECT message FROM activity_log ORDER BY id').all();
    assert.ok(rows.every((r) => r.message.startsWith('ws2 entry')), 'ws2 rows mutated');
  });

  check('A4 the clear itself writes NO activity_log row (panel cannot refill itself)', () => {
    assert.equal(count(wdb1), 0);
    const selfRows = wdb1
      .prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE message LIKE '%clear%'`)
      .get().c;
    assert.equal(selfRows, 0);
  });

  check('A5 clearing an empty log is a clean no-op (deleted 0)', () => {
    const out = domain.adminClearActivity(1, { confirm: 'DELETE' });
    assert.equal(out.deleted, 0);
    assert.equal(count(wdb1), 0);
  });

  check('A6 activity keeps logging and reading normally after a clear', () => {
    seed(wdb1, 1, 'after-clear');
    const recent = domain.activityRecent(1, {});
    assert.equal(recent.total, 1);
    assert.equal(recent.rows[0].message, 'after-clear entry 1');
    const stats = domain.dashboardStats(1);
    assert.equal(stats.activity.length, 1);
  });
}

async function testRoute() {
  await platformDb.migrate();
  const express = require('express');
  const router = require(path.join(root, 'server/routes/domainApi.js'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      via: req.get('x-test-via') || 'session',
      userId: 999,
      workspaceId: 1,
      role: req.get('x-test-role') || 'owner',
      leadId: req.get('x-test-lead') ? Number(req.get('x-test-lead')) : null,
    };
    next();
  });
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (headers = {}, body = { confirm: 'DELETE' }) =>
    fetch(`${base}/admin-area/activity/clear-all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    // ws1 holds the 1 'after-clear' row from A6; add 2 more → 3.
    seed(wdb1, 2, 'route');
    await checkAsync('B1 owner session clears via the route and gets the exact count', async () => {
      const res = await post();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.deleted, 3);
      assert.equal(count(wdb1), 0);
    });

    await checkAsync('B2 the clear is recorded in the PLATFORM audit log (actor, workspace, count)', async () => {
      const rows = await platformDb.query(
        `SELECT actor_user_id, action, detail FROM platform_audit WHERE action = :a`,
        { a: 'activity.clear' }
      );
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].actor_user_id), 999);
      assert.match(rows[0].detail, /workspaceId=1/);
      assert.match(rows[0].detail, /deleted=3/);
    });

    seed(wdb1, 2, 'guarded');
    await checkAsync('B3 non-staff role is rejected and deletes nothing', async () => {
      const res = await post({ 'x-test-role': 'member' });
      assert.equal(res.status, 403);
      assert.equal(count(wdb1), 2);
    });

    await checkAsync('B4 a lead-scoped token is rejected and deletes nothing', async () => {
      const res = await post({ 'x-test-via': 'token', 'x-test-role': 'token', 'x-test-lead': '5' });
      assert.equal(res.status, 403);
      assert.equal(count(wdb1), 2);
    });

    await checkAsync('B5 the route enforces confirm=DELETE too (400 CONFIRM_REQUIRED)', async () => {
      const res = await post({}, {});
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error && body.error.code, 'CONFIRM_REQUIRED');
      assert.equal(count(wdb1), 2);
    });

    await checkAsync('B6 rejected attempts write no extra platform audit rows', async () => {
      const rows = await platformDb.query(
        `SELECT COUNT(*) AS c FROM platform_audit WHERE action = :a`,
        { a: 'activity.clear' }
      );
      assert.equal(Number(rows[0].c), 1);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function testWiring() {
  const domainApi = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

  check('W1 route registration carries the Batch 51 staff guard chain', () => {
    assert.ok(
      domainApi.includes(
        "router.post('/admin-area/activity/clear-all', requireRole('owner', 'admin'), denyLeadScopedToken"
      ),
      'guarded activity clear-all route missing'
    );
    assert.ok(domainApi.includes("require('../platform').audit("), 'platform audit call missing');
    assert.ok(domainApi.includes("'activity.clear'"), 'audit action missing');
  });

  check('W2 api client exposes adminClearAllActivity on the same path', () => {
    assert.ok(apiJs.includes("adminClearAllActivity: (body) => post('/admin-area/activity/clear-all'"));
  });

  check('W3 BOTH Recent activity panels render the Clear all button (rows-only)', () => {
    const button =
      '<button class="btn small danger" data-act="clear-activity">Clear all…</button>';
    assert.equal(appJs.split(button).length - 1, 2, 'expected the button in Dashboard + Analytics');
    assert.equal(
      appJs.split("activity.length ? '<button").length - 1 >= 2,
      true,
      'button must be conditional on rows existing'
    );
  });

  check('W4 shared flow states the count + cannot-be-undone and type-DELETE, then re-renders', () => {
    assert.ok(appJs.includes('async function runClearActivityFlow(refresh)'), 'shared flow missing');
    assert.ok(appJs.includes('This cannot be undone.'), 'cannot-be-undone wording missing');
    assert.ok(appJs.includes("prompt('Type DELETE to confirm')"), 'type-to-confirm missing');
    assert.ok(appJs.includes('runClearActivityFlow(() => pageDashboard())'), 'dashboard wiring missing');
    assert.ok(appJs.includes('runClearActivityFlow(() => pageAnalytics())'), 'analytics wiring missing');
  });

  check('W5 empty-state copy unchanged (cleared panel lands on "No activity yet.")', () => {
    assert.ok(appJs.split('<li class="hint">No activity yet.</li>').length - 1 >= 2);
  });
}

(async () => {
  testFacade();
  await testRoute();
  testWiring();
  console.log(
    JSON.stringify({ file: 'batch72-clear-activity-regressions', passed: results.length, checks: results }, null, 2)
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
