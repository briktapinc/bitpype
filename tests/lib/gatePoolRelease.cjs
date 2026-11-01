'use strict';
// Batch 112 — MySQL-pass suite lifecycle helper (preload, gate only).
//
// Suites are scripts whose success path usually ends by letting the
// event loop drain. In the SQLite pass that works: better-sqlite3
// holds no loop references. In the MySQL pass, a suite that opened
// the platform pool in-process (server/db.js) would linger forever
// on the pool's sockets — correct behaviour for a server, wrong for
// a test process — and the runner would have to kill it as a false
// timeout failure.
//
// This preload (wired ONLY into the runner's --mysql spawns) watches
// for genuine quiescence and then releases the pool via db.close():
//   * no facade call in flight (query/withConnection/migrate/ping
//     are counted by wrapping the shared exports object),
//   * no active async requests (fs/crypto/zlib),
//   * no active handles other than stdio, this timer, and sockets
//     to the gate MySQL port,
// sustained for QUIET_SAMPLES consecutive samples. Closing is safe
// mid-suite by construction: db.close() is idempotent, an in-flight
// call is excluded by the counter, and a later call lazily reopens
// the pool. The release never forces an exit and never touches an
// assertion — worst case it churns the pool. Every release is
// logged to stderr so gate logs show exactly when it acted.
if (process.env.REGRESSION_DB_DRIVER === 'mysql') {
  const db = require('../../server/db');
  const mysqlPort = Number(process.env.MYSQL_PORT || 3306);

  let inFlight = 0;
  for (const key of ['query', 'withConnection', 'migrate', 'ping']) {
    const original = db[key];
    if (typeof original !== 'function') continue;
    db[key] = function (...args) {
      inFlight++;
      let result;
      try {
        result = original.apply(this, args);
      } catch (e) {
        inFlight--;
        throw e;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (v) => {
            inFlight--;
            return v;
          },
          (e) => {
            inFlight--;
            throw e;
          }
        );
      }
      inFlight--;
      return result;
    };
  }

  const SAMPLE_MS = 300;
  const QUIET_SAMPLES = 6; // ~1.8s of sustained quiescence
  let quiet = 0;
  let releasing = false;

  const timer = setInterval(() => {
    if (releasing) return;
    let blocked = inFlight > 0;
    if (!blocked && process._getActiveRequests().length > 0) blocked = true;
    if (!blocked) {
      for (const h of process._getActiveHandles()) {
        if (h === timer) continue;
        const name = (h.constructor && h.constructor.name) || '';
        if (name === 'Socket' || name === 'TLSSocket') {
          if (!h.remotePort) continue; // stdio pipes / unconnected
          if (h.remotePort === mysqlPort) continue; // the pool itself
          blocked = true; // a live connection to something else (suite server, browser, ...)
          break;
        }
        if (
          name === 'Server' ||
          name === 'ChildProcess' ||
          name === 'FSWatcher' ||
          name === 'StatWatcher' ||
          name === 'Worker' ||
          name === 'MessagePort' ||
          name === 'Timeout' ||
          name === 'Interval' ||
          name === 'Immediate' ||
          name === 'UDP'
        ) {
          blocked = true;
          break;
        }
        // ReadStream/WriteStream (stdio, files) and transient request
        // handles do not block; anything unrecognized also does not
        // block on its own — the in-flight counter and the request
        // list above are the authoritative work signals.
      }
    }
    if (blocked) {
      quiet = 0;
      return;
    }
    quiet++;
    if (quiet < QUIET_SAMPLES) return;
    quiet = 0;
    releasing = true;
    db.close()
      .catch(() => {})
      .finally(() => {
        releasing = false;
        console.error('GATE-POOL-RELEASE: platform pool released after quiescence');
      });
  }, SAMPLE_MS);
  timer.unref();
}
