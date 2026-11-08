'use strict';
/**
 * Batch 160 — job-execution lock: ONE atomic claim on both dialects.
 *
 * Background: the MySQL claim used GET_LOCK on a brand-new dedicated
 * connection per attempt. Under gate load that connection setup took
 * ~1s+ with several hundred ms of skew between contenders, so a slow
 * contender's GET_LOCK landed only AFTER the winner had released —
 * it acquired a free lock and ran the job a second time
 * (job-concurrency-regressions: 2 winners on the MySQL leg,
 * reproduced with a timestamped probe: winner claimed t+1076ms,
 * released t+1468ms, straggler claimed t+1577ms). The fix removes
 * the GET_LOCK path entirely: every dialect claims with a single
 * INSERT IGNORE against job_execution_locks (PRIMARY KEY
 * (workspace_id, job_id)) — affectedRows decides the winner — the
 * Batch 143 reclaim rules (same-host dead pid, else >24h
 * staleness, owner-token CAS) apply uniformly, and on MySQL the
 * claim statements travel over ONE persistent connection per
 * process, warmed at module load, so a claim never pays cold
 * connection setup at claim time (the setup skew WAS the race).
 *
 * Pins:
 *   Part 1 — source: no GET_LOCK / exactly one persistent claim
 *     connection (never one per attempt) / no capacity counter;
 *     the atomic claim statements exist.
 *   Part 2 — baseline: acquire runs fn and returns its value; the
 *     lock row is deleted on clean release.
 *   Part 3 — in-process: 20 simultaneous claims on one job yield
 *     exactly 1 runner and 19 JOB_RUNNING.
 *   Part 4 — reclaim on the RUNNING dialect (incl. MySQL, which
 *     Batch 143's suite skips): a >24h foreign-host row is reclaimed
 *     by exactly one of 8 concurrent contenders (owner-token CAS);
 *     a fresh foreign-host row fails closed; a fresh same-host row
 *     whose owner pid is dead is reclaimed via the pid check.
 *   Part 5 — cross-process: 4 forked processes race one job;
 *     exactly 1 runs, the rest get JOB_RUNNING.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const temp = process.env.JOB_LOCK_FIXTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bitpype-lock160-'));
if (!process.env.DB_DRIVER) process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
if (process.env.DB_DRIVER === 'sqlite') process.env.SQLITE_PATH = path.join(temp, 'lock160.sqlite');
const db = require('../server/db');
const { query } = db;
const { withJobLock } = require('../server/jobExecutionLock');

const worker = process.argv[2] === 'worker';
if (worker) {
  process.on('message', async (m) => {
    if (!m.go) return;
    try {
      await withJobLock(1, m.jobId, async () => {
        fs.appendFileSync(path.join(temp, 'entrants.log'), String(process.pid) + '\n');
        await new Promise((r) => setTimeout(r, 300));
      });
      process.send({ ok: true });
    } catch (e) {
      process.send({ ok: false, code: e.code });
    }
    process.exit(0);
  });
  process.send({ ready: true });
} else {
  (async () => {
    let groups = 0;
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'jobExecutionLock.js'), 'utf8');
    assert.ok(!src.includes('GET_LOCK('), 'GET_LOCK call removed');
    assert.equal(
      src.split('createConnection').length - 1,
      1,
      'exactly one persistent claim connection is created (never one per claim attempt)'
    );
    assert.ok(src.includes('claimConnection'), 'persistent claim-connection transport present');
    assert.ok(!src.includes('lockConnections'), 'connection capacity counter removed');
    assert.ok(src.includes('INSERT IGNORE INTO job_execution_locks'), 'single-statement atomic claim present');
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS job_execution_locks'), 'locks table ensured on both dialects');
    assert.ok(src.includes('AND owner=:oldOwner'), 'owner-token CAS reclaim present');
    groups++;

    await db.migrate();
    const ran = await withJobLock(1, 160001, async () => 'ran');
    assert.equal(ran, 'ran', 'baseline claim runs fn');
    const left = await query('SELECT * FROM job_execution_locks WHERE workspace_id=1 AND job_id=160001');
    assert.equal(left.length, 0, 'lock row deleted on clean release');
    groups++;

    // Part 3 — in-process simultaneity.
    let runners = 0;
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        withJobLock(1, 160002, async () => {
          runners++;
          await new Promise((r) => setTimeout(r, 120));
          return 'won';
        })
      )
    );
    assert.equal(runners, 1, 'exactly one in-process runner');
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, 'exactly one fulfilled claim');
    for (const s of settled.filter((s) => s.status === 'rejected'))
      assert.equal(s.reason.code, 'JOB_RUNNING', 'losers get JOB_RUNNING');
    groups++;

    // Part 4 — reclaim rules on the running dialect.
    const staleIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await query(
      'INSERT INTO job_execution_locks (workspace_id, job_id, owner, owner_pid, owner_host, claimed_at) VALUES (1, 160003, :owner, 999999, :host, :at)',
      { owner: 'staleowner160', host: 'dead-container-host', at: staleIso }
    );
    let reclaimers = 0;
    const storm = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        withJobLock(1, 160003, async () => {
          reclaimers++;
          await new Promise((r) => setTimeout(r, 60));
          return 'reclaimed';
        })
      )
    );
    assert.equal(reclaimers, 1, 'exactly one reclaimer wins the CAS storm');
    assert.equal(storm.filter((s) => s.status === 'fulfilled').length, 1, 'exactly one fulfilled reclaim');
    for (const s of storm.filter((s) => s.status === 'rejected'))
      assert.equal(s.reason.code, 'JOB_RUNNING', 'reclaim losers get JOB_RUNNING');

    await query(
      'INSERT INTO job_execution_locks (workspace_id, job_id, owner, owner_pid, owner_host, claimed_at) VALUES (1, 160004, :owner, 999999, :host, :at)',
      { owner: 'freshowner160', host: 'live-container-host', at: new Date().toISOString() }
    );
    let code = '';
    try {
      await withJobLock(1, 160004, async () => 'nope');
    } catch (e) {
      code = e.code || '';
    }
    assert.equal(code, 'JOB_RUNNING', 'fresh foreign-host lock fails closed');
    await query('DELETE FROM job_execution_locks WHERE workspace_id=1 AND job_id=160004');

    await query(
      'INSERT INTO job_execution_locks (workspace_id, job_id, owner, owner_pid, owner_host, claimed_at) VALUES (1, 160005, :owner, 999999, :host, :at)',
      { owner: 'deadpid160', host: os.hostname(), at: new Date().toISOString() }
    );
    const pidReclaimed = await withJobLock(1, 160005, async () => 'pid-reclaimed');
    assert.equal(pidReclaimed, 'pid-reclaimed', 'fresh same-host row with a dead owner pid is reclaimed');
    groups++;

    // Part 5 — cross-process race (the original regression shape).
    try {
      fs.unlinkSync(path.join(temp, 'entrants.log'));
    } catch {
      /* no entrants yet */
    }
    function child() {
      return fork(__filename, ['worker'], {
        env: { ...process.env, JOB_LOCK_FIXTURE_DIR: temp },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    }
    const children = Array.from({ length: 4 }, () => child());
    await Promise.all(
      children.map(
        (c) =>
          new Promise((resolve, reject) => {
            c.on('message', (m) => {
              if (m.ready) resolve();
            });
            c.on('error', reject);
          })
      )
    );
    const completed = children.map(
      (c) =>
        new Promise((resolve, reject) => {
          let receipt;
          c.on('message', (m) => {
            if ('ok' in m) receipt = m;
          });
          c.on('exit', (c2) => (c2 ? reject(new Error('worker exited ' + c2)) : resolve(receipt)));
          c.on('error', reject);
        })
    );
    children.forEach((c) => c.send({ go: true, jobId: 160006 }));
    const receipts = await Promise.all(completed);
    assert.equal(receipts.filter((r) => r && r.ok).length, 1, 'exactly one cross-process winner');
    for (const r of receipts.filter((r) => r && !r.ok)) assert.equal(r.code, 'JOB_RUNNING');
    const entrants = fs
      .readFileSync(path.join(temp, 'entrants.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(entrants.length, 1, 'exactly one process entered the locked body');
    groups++;

    console.log(
      JSON.stringify({
        passed: true,
        groups,
        driver: process.env.DB_DRIVER,
        checks: [
          'source pins (no GET_LOCK, atomic claim)',
          'baseline acquire + clean release deletes the row',
          'in-process 20-way exclusivity',
          'reclaim: CAS storm / fresh-foreign fail-closed / dead-pid reclaim',
          'cross-process 4-way exclusivity',
        ],
      })
    );
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
