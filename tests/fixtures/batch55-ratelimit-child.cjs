'use strict';
/**
 * Batch 55 fixture — rate-limiter restart persistence.
 *
 * Spawned as a FRESH process by tests/batch55-hygiene-regressions.cjs,
 * twice against the same platform DB (DB_DRIVER/SQLITE_PATH from the
 * parent's env). Process 1 exhausts a named bucket's budget; process 2
 * — a brand-new process with empty memory, i.e. a simulated app
 * restart — must still see the budget as spent. Before Batch 55 the
 * counters lived in a per-process Map and process 2 would have started
 * from zero.
 *
 * Env: RL_NAME (bucket), RL_MAX, RL_WINDOW_MS, RL_HITS, RL_KEY.
 * Prints one JSON line: { allowed, limited }.
 */

const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const { rateLimit } = require(path.join(root, 'server/rateLimit.js'));

(async () => {
  const max = Number(process.env.RL_MAX || 3);
  const hits = Number(process.env.RL_HITS || 1);
  const mw = rateLimit({
    windowMs: Number(process.env.RL_WINDOW_MS || 15 * 60 * 1000),
    max,
    name: process.env.RL_NAME || 'batch55-restart',
  });
  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < hits; i++) {
    const outcome = await new Promise((resolve) => {
      const req = { ip: process.env.RL_KEY || '203.0.113.55' };
      const res = {
        status(code) {
          this.code = code;
          return this;
        },
        json() {
          resolve('limited');
          return this;
        },
      };
      Promise.resolve(mw(req, res, () => resolve('allowed'))).catch(() => resolve('limited'));
    });
    if (outcome === 'allowed') allowed++;
    else limited++;
  }
  process.stdout.write(JSON.stringify({ allowed, limited }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exit(1);
});
