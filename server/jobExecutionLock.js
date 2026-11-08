'use strict';
const crypto = require('node:crypto'),
  os = require('node:os');
const { query, mysqlConfig, driver } = require('./db');
function conflict() {
  return Object.assign(new Error('Job is already running'), { code: 'JOB_RUNNING', status: 409 });
}
// Batch 160 (claim transport): on MySQL the lock statements below
// run over ONE dedicated connection per process, established in the
// background at module load (see the warm-up at the bottom) and
// serialized through a promise chain. A claim must never pay
// connection setup at claim time: on a loaded host a cold connect
// takes ~1s with several hundred ms of skew between racing
// processes, which is longer than a short job's whole run — a slow
// contender's claim then lands only after the winner released and
// the job runs twice (the original defect, first seen with a fresh
// GET_LOCK connection per attempt). With the connection already
// open, every contender's claim is a single round trip and the
// statements land within a few ms of each other. Job bodies still
// run on the shared pool; only the four lock statements use this
// connection. Any failure on it falls back to the shared pool with
// the same statement (the claim insert is idempotent — see the
// self-token recognition in withJobLock). sqlite keeps the shared
// path: its claim is one statement on an already-open database.
let claimConnPromise = null;
function claimConnection() {
  if (claimConnPromise) return claimConnPromise;
  const p = (async () => {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection(mysqlConfig());
    try {
      conn.connection.stream.unref();
    } catch {
      /* mysql2 shape differs — the socket simply stays ref'd */
    }
    conn.on('error', () => {
      if (claimConnPromise === p) claimConnPromise = null;
    });
    return conn;
  })();
  claimConnPromise = p;
  p.catch(() => {
    if (claimConnPromise === p) claimConnPromise = null;
  });
  return p;
}
let claimChain = Promise.resolve();
function lockQuery(sqlText, params) {
  if (driver() !== 'mysql') return query(sqlText, params);
  const run = claimChain.then(async () => {
    try {
      const conn = await claimConnection();
      const [result] = await conn.execute(sqlText, params || {});
      return result;
    } catch {
      claimConnPromise = null;
      return query(sqlText, params);
    }
  });
  claimChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
async function withJobLock(workspaceId, jobId, fn) {
  const ws = Number(workspaceId),
    id = Number(jobId);
  if (!Number.isSafeInteger(ws) || ws <= 0 || !Number.isSafeInteger(id) || id <= 0)
    throw Object.assign(new Error('Invalid job identity'), { code: 'INVALID', status: 400 });
  // Batch 160: ONE claim path for both dialects — a single atomic
  // INSERT IGNORE against job_execution_locks (PRIMARY KEY
  // (workspace_id, job_id)) decides the winner: exactly one
  // contender's statement lands the row. The previous MySQL path
  // claimed with GET_LOCK on a brand-new dedicated connection per
  // attempt; under load that connection setup took ~1s+ with several
  // hundred ms of skew between contenders, so a slow contender's
  // claim could land only AFTER the winner had already released —
  // it then acquired a free lock and ran the job a second time
  // (job-concurrency-regressions: 2 winners on the MySQL gate leg,
  // reproduced with a timestamped probe). The claim transport above
  // removes the setup from claim time on MySQL. A table row also outlives
  // the holder's process, so the dead-owner reclaim below (pid
  // liveness on the same host, else the Batch 143 24h staleness
  // rule) now applies on MySQL exactly as it always did on sqlite;
  // in the single-container production topology every app process
  // shares host + pid namespace, so a crashed holder is reclaimed by
  // the pid check, not the 24h rule.
  const owner = crypto.randomBytes(24).toString('hex'),
    host = os.hostname(),
    nowIso = new Date().toISOString();
  // Written in MySQL flavour; server/db translates INSERT IGNORE to
  // INSERT OR IGNORE for sqlite. affectedRows is 1 only for the
  // contender whose insert actually landed. The claim is attempted
  // FIRST so the steady-state claim stays a single statement (no
  // DDL runway in front of it); only a failing claim — the table
  // does not exist yet on this database, or it is a pre-143 table
  // without claimed_at — pays for the schema ensure + one retry.
  const claim = () =>
    lockQuery('INSERT IGNORE INTO job_execution_locks VALUES (:ws,:id,:owner,:pid,:host,:at)', {
      ws,
      id,
      owner,
      pid: process.pid,
      host,
      at: nowIso,
    });
  let inserted;
  try {
    inserted = await claim();
  } catch {
    await query(
      `CREATE TABLE IF NOT EXISTS job_execution_locks (workspace_id INTEGER NOT NULL,job_id INTEGER NOT NULL,owner TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_host TEXT NOT NULL,claimed_at TEXT,PRIMARY KEY(workspace_id,job_id))`
    );
    // Batch 143 (full review): pre-143 tables have no claimed_at
    // column; add it (duplicate-column error on later boots ignored).
    try {
      await query('ALTER TABLE job_execution_locks ADD COLUMN claimed_at TEXT');
    } catch {
      /* column already exists */
    }
    inserted = await claim();
  }
  if (!Number(inserted.affectedRows)) {
    const [old] = await lockQuery('SELECT * FROM job_execution_locks WHERE workspace_id=:ws AND job_id=:id', {
      ws,
      id,
    });
    // Our own token already in the row means our claim DID land and
    // only its response was lost (the pool fallback in lockQuery can
    // re-run a claim whose first attempt actually landed) — we hold
    // the lock; skip the contention logic entirely.
    if (!old || old.owner !== owner) {
      let dead = false;
      if (old && old.owner_host === host) {
        try {
          process.kill(Number(old.owner_pid), 0);
        } catch (e) {
          dead = e.code === 'ESRCH';
        }
      }
      // Batch 143: a lock older than 24h is reclaimable even when its
      // owner lived on another host. The old rule wedged a job forever
      // whenever the lock row outlived its container (hostnames change
      // per deploy) — no job in this system runs anywhere near a day.
      // Anything fresher stays fail-closed, and the owner-token CAS
      // below still guarantees exactly one reclaimer. A legacy row
      // with no claimed_at is stamped now and judged on the next try.
      if (!dead && old) {
        const claimedMs = old.claimed_at ? Date.parse(old.claimed_at) : NaN;
        if (Number.isFinite(claimedMs) && Date.now() - claimedMs > 24 * 60 * 60 * 1000) {
          dead = true;
        } else if (!Number.isFinite(claimedMs)) {
          await lockQuery(
            'UPDATE job_execution_locks SET claimed_at=:at WHERE workspace_id=:ws AND job_id=:id AND owner=:oldOwner AND claimed_at IS NULL',
            { ws, id, at: nowIso, oldOwner: old.owner }
          );
        }
      }
      if (!dead) throw conflict();
      const changed = await lockQuery(
        'UPDATE job_execution_locks SET owner=:owner,owner_pid=:pid,owner_host=:host,claimed_at=:at WHERE workspace_id=:ws AND job_id=:id AND owner=:oldOwner',
        { ws, id, owner, pid: process.pid, host, at: nowIso, oldOwner: old.owner }
      );
      if (!Number(changed.affectedRows)) {
        // The CAS may have landed while its response was lost (see
        // lockQuery's fallback): only another owner holding the row
        // means we truly lost the reclaim race.
        const [again] = await lockQuery('SELECT owner FROM job_execution_locks WHERE workspace_id=:ws AND job_id=:id', {
          ws,
          id,
        });
        if (!again || again.owner !== owner) throw conflict();
      }
    }
  }
  try {
    return await fn();
  } finally {
    await lockQuery('DELETE FROM job_execution_locks WHERE workspace_id=:ws AND job_id=:id AND owner=:owner', {
      ws,
      id,
      owner,
    });
  }
}
// Warm the claim connection in the background (MySQL only) so the
// first claim in this process never pays connection setup. Failure
// is fine: claimConnection resets and the first claim retries or
// falls back to the shared pool.
if (driver() === 'mysql') claimConnection().catch(() => {});
module.exports = { withJobLock };
