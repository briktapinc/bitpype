'use strict';
/**
 * Batch 49 — Admin Finance dashboard (server/finance.js engine).
 *
 * Every figure comes from data the app already records — nothing is
 * invented:
 *   1. Domains: only 'live' domain_transactions count as spent, at
 *      registrar_price_cents (the actual Cloudflare cost), dated by
 *      completion. Voided / pending / failed / paid-but-not-registered
 *      rows never count. NEGATIVE PROOF: run with B49_NEGATIVE=1 — the
 *      test widens SPENT_TXN_STATUSES to include the excluded statuses
 *      and the domain-total check MUST fail (verified manually).
 *   2. Collected: amount_paid_cents on paid/registering/live only.
 *   3. AI: ai_usage sums (calls, tokens, by-task, by-model) and the
 *      payload flags the figures as estimates.
 *   4. Manual expenses: add/validate/delete + category totals.
 *   5. Period boundaries are inclusive on both ends; presets resolve
 *      against an injected "now".
 *   6. Ledger: unified rows (domain per-txn, AI per-day aggregate,
 *      manual), paginated 25/page, category filter, deletable flags.
 *   7. CSV: exact header, one line per ledger row, comma labels quoted,
 *      excluded transactions absent.
 *   8. Series: daily ≤92d, weekly ≤371d, monthly beyond.
 *   9. Role guard: the real requireRole middleware denies a 'member'
 *      session and any token caller; the finance mutation routes are
 *      structurally pinned to requireRole('owner', 'admin').
 *  10. Empty workspace: every figure is an honest 0.
 *
 * Pure engine tests on in-memory sqlite — no network, no Stripe, no
 * Cloudflare. Run via tests/run-regressions.cjs (DB_DRIVER=sqlite).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-b49-'));
process.env.DB_DRIVER = process.env.REGRESSION_DB_DRIVER || 'sqlite';
process.env.SQLITE_PATH = path.join(temp, 'platform.sqlite');
process.env.WORKSPACE_DATA_DIR = path.join(temp, 'workspaces');
process.env.EXPORT_ROOT = path.join(temp, 'exports');
process.env.SESSION_SECRET = ['b49', 'test', 'secret'].join('-');
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('node:sqlite').DatabaseSync;
}

const finance = require(path.join(root, 'server/finance.js'));
const domainFlow = require(path.join(root, 'server/domainFlow.js'));
const middleware = require(path.join(root, 'server/middleware.js'));

if (process.env.B49_NEGATIVE === '1') {
  // Negative-proof shim: pretend the spent-status exclusion was dropped.
  finance.SPENT_TXN_STATUSES.push('voided', 'pending_payment', 'failed', 'paid', 'registering');
}

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}
const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push([name, fn]);
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'));
  domainFlow.ensureTables(db);
  finance.ensureTables(db);
  return db;
}

let txnSeq = 0;
function addTxn(db, o) {
  txnSeq += 1;
  db.prepare(
    `INSERT INTO domain_transactions
       (id, lead_id, website_id, domain, registrar_price_cents, registrar_currency, plan_id,
        amount_paid_cents, status, created_at, paid_at, completed_at)
     VALUES (?, 1, NULL, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`
  ).run(
    txnSeq,
    o.domain || `domain-${txnSeq}.com`,
    o.registrar == null ? null : o.registrar,
    o.plan || 'standard',
    o.paid == null ? null : o.paid,
    o.status,
    o.createdAt || '2026-10-01 09:00:00',
    o.paidAt || null,
    o.completedAt || null
  );
  return txnSeq;
}

function addAi(db, o) {
  db.prepare(
    `INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(o.task || 'research', o.model || 'gpt-test', o.pt || 100, o.ct || 50, o.cost, o.at);
}

const OCT = { preset: 'custom', from: '2026-10-01', to: '2026-10-31' };

// ---------------------------------------------------------------- fixtures
const db = makeDb();
// Domains — spent (live): 1046 + 1200 + 700(completed in Oct, created Sep) = 2946
addTxn(db, { domain: 'alpha.com', status: 'live', registrar: 1046, paid: 9900, createdAt: '2026-10-10 08:00:00', paidAt: '2026-10-10 08:05:00', completedAt: '2026-10-10 09:00:00' });
addTxn(db, { domain: 'beta.com', status: 'live', registrar: 1200, paid: 9900, createdAt: '2026-10-20 08:00:00', paidAt: '2026-10-20 08:05:00', completedAt: '2026-10-20 09:00:00' });
addTxn(db, { domain: 'gamma.com', status: 'live', registrar: 700, paid: 9900, createdAt: '2026-09-15 08:00:00', paidAt: '2026-09-15 08:05:00', completedAt: '2026-10-05 09:00:00' });
// Domains — never spent: voided / pending / failed / paid / registering
addTxn(db, { domain: 'voided.com', status: 'voided', registrar: 5000, paid: 9900, paidAt: '2026-10-11 08:05:00' });
addTxn(db, { domain: 'pending.com', status: 'pending_payment', registrar: 3000 });
addTxn(db, { domain: 'failed.com', status: 'failed', registrar: 2500, paid: 9900, paidAt: '2026-10-12 08:05:00' });
addTxn(db, { domain: 'paidonly.com', status: 'paid', registrar: 4000, paid: 9900, paidAt: '2026-10-13 08:05:00' });
addTxn(db, { domain: 'registering.com', status: 'registering', registrar: 4500, paid: 9900, paidAt: '2026-10-14 08:05:00' });
// AI — Oct 3: 0.50 + 0.25; Oct 4: 1.00 → 175 cents, 3 calls
addAi(db, { at: '2026-10-03 10:00:00', cost: 0.5, task: 'research', model: 'm1', pt: 1000, ct: 500 });
addAi(db, { at: '2026-10-03 11:00:00', cost: 0.25, task: 'generation', model: 'm2', pt: 200, ct: 100 });
addAi(db, { at: '2026-10-04 09:00:00', cost: 1.0, task: 'research', model: 'm1', pt: 300, ct: 150 });
addAi(db, { at: '2026-11-01 00:00:00', cost: 9.99, task: 'research', model: 'm1' }); // outside Oct

const period = finance.resolvePeriod(OCT, new Date('2026-10-28T12:00:00Z'));
assert.deepEqual([period.from, period.to], ['2026-10-01', '2026-10-31']);

// ------------------------------------------------------------------- checks
check('domains: only live transactions count, at registrar cost, dated by completion', () => {
  const s = finance.summary(db, period);
  assert.equal(s.categories.domains.autoCents, 2946);
  assert.equal(s.categories.domains.txnCount, 3);
  const sep = finance.summary(db, finance.resolvePeriod({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' }));
  assert.equal(sep.categories.domains.autoCents, 0, 'gamma.com completed in Oct — nothing spent in Sep');
});

check('collected: amount_paid on paid/registering/live only', () => {
  const s = finance.summary(db, period);
  // live alpha+beta (9900×2, paid in Oct) + paidonly 9900 + registering 9900 = 39600;
  // gamma paid in Sep (excluded by period), voided + failed excluded by status.
  assert.equal(s.collected.cents, 39600);
  assert.equal(s.collected.count, 4);
});

check('ai: sums, tokens, breakdowns, estimate flag + note', () => {
  const s = finance.summary(db, period);
  const ai = s.categories.ai;
  assert.equal(ai.autoCents, 175);
  assert.equal(ai.calls, 3);
  assert.equal(ai.promptTokens, 1500);
  assert.equal(ai.completionTokens, 750);
  assert.equal(ai.estimated, true);
  assert.match(s.aiNote, /estimate/i);
  assert.deepEqual(
    ai.byTask.map((r) => [r.key, r.cents, r.calls]),
    [
      ['research', 150, 2],
      ['generation', 25, 1],
    ]
  );
  assert.equal(ai.byModel.length, 2);
});

check('manual expenses: add, totals, validation, delete', () => {
  const row = finance.addExpense(db, { date: '2026-10-06', category: 'cloudflare', label: 'Workers Paid plan', amountCents: 500, createdBy: 7 });
  assert.ok(row.id > 0);
  assert.equal(row.categoryLabel, 'Cloudflare');
  finance.addExpense(db, { date: '2026-10-07', category: 'domains', label: 'Manual domain renewal', amountCents: 999 });
  let s = finance.summary(db, period);
  assert.equal(s.categories.cloudflare.totalCents, 500);
  assert.equal(s.categories.domains.totalCents, 2946 + 999);
  assert.equal(s.totalExpenditureCents, 2946 + 999 + 175 + 500);

  for (const bad of [
    { date: '2026-02-30', category: 'other', label: 'x', amountCents: 100 },
    { date: '2026-10-06', category: 'bogus', label: 'x', amountCents: 100 },
    { date: '2026-10-06', category: 'other', label: '  ', amountCents: 100 },
    { date: '2026-10-06', category: 'other', label: 'x', amountCents: 0 },
    { date: '2026-10-06', category: 'other', label: 'x', amountCents: 10.5 },
  ]) {
    assert.throws(() => finance.addExpense(db, bad), (e) => e.code === 'INVALID');
  }
  const out = finance.deleteExpense(db, row.id);
  assert.equal(out.ok, true);
  s = finance.summary(db, period);
  assert.equal(s.categories.cloudflare.totalCents, 0);
  assert.throws(() => finance.deleteExpense(db, row.id), (e) => e.code === 'NOT_FOUND');
});

check('period boundaries are inclusive on both ends', () => {
  finance.addExpense(db, { date: '2026-10-01', category: 'hosting', label: 'edge from', amountCents: 100 });
  finance.addExpense(db, { date: '2026-10-31', category: 'hosting', label: 'edge to', amountCents: 200 });
  finance.addExpense(db, { date: '2026-09-30', category: 'hosting', label: 'before', amountCents: 400 });
  finance.addExpense(db, { date: '2026-11-01', category: 'hosting', label: 'after', amountCents: 800 });
  const s = finance.summary(db, period);
  assert.equal(s.categories.hosting.totalCents, 300);
});

check('presets resolve against an injected now; bad input is INVALID', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  assert.deepEqual(
    (({ from, to }) => [from, to])(finance.resolvePeriod({ preset: 'today' }, now)),
    ['2026-10-28', '2026-10-28']
  );
  assert.deepEqual(
    (({ from, to }) => [from, to])(finance.resolvePeriod({ preset: '7d' }, now)),
    ['2026-10-22', '2026-10-28']
  );
  assert.deepEqual(
    (({ from, to }) => [from, to])(finance.resolvePeriod({ preset: 'mtd' }, now)),
    ['2026-10-01', '2026-10-28']
  );
  assert.throws(() => finance.resolvePeriod({ preset: 'nope' }, now), (e) => e.code === 'INVALID');
  assert.throws(
    () => finance.resolvePeriod({ preset: 'custom', from: '2026-10-31', to: '2026-10-01' }, now),
    (e) => e.code === 'INVALID'
  );
});

check('ledger: unified rows, pagination, category filter, deletable flags', () => {
  for (let i = 0; i < 30; i++) {
    finance.addExpense(db, {
      date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
      category: i % 3 === 0 ? 'calls' : 'other',
      label: `bulk ${i}`,
      amountCents: 100 + i,
    });
  }
  const p1 = finance.ledger(db, period, { page: 1, pageSize: 25 });
  assert.equal(p1.rows.length, 25);
  assert.ok(p1.total >= 30 + 3 + 2 + 3, `total covers manual + domain + ai rows (got ${p1.total})`);
  const p2 = finance.ledger(db, period, { page: 2, pageSize: 25 });
  assert.ok(p2.rows.length >= 5);
  assert.equal(p1.pages, Math.ceil(p1.total / 25));

  const aiRows = finance.ledger(db, period, { category: 'ai', pageSize: 50 }).rows;
  assert.equal(aiRows.length, 2, 'one AI aggregate row per active day');
  const oct3 = aiRows.find((r) => r.date === '2026-10-03');
  assert.equal(oct3.amountCents, 75);
  assert.match(oct3.label, /estimated/);
  assert.equal(oct3.deletable, false);

  const domRows = finance.ledger(db, period, { category: 'domains', pageSize: 50 }).rows;
  assert.ok(domRows.some((r) => r.label.includes('alpha.com') && r.amountCents === 1046 && r.source === 'auto'));
  assert.ok(!domRows.some((r) => r.label.includes('voided.com')), 'voided txn never reaches the ledger');

  const manual = finance.ledger(db, period, { category: 'calls', pageSize: 50 }).rows;
  assert.ok(manual.length >= 10 && manual.every((r) => r.source === 'manual' && r.deletable === true));
});

check('csv: header, row count, quoting, exclusions', () => {
  finance.addExpense(db, { date: '2026-10-09', category: 'hosting', label: 'VPS, main box', amountCents: 1200 });
  const csv = finance.ledgerCsv(db, period, {});
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'date,category,source,label,amount_usd');
  const all = finance.ledgerAll(db, period, {});
  assert.equal(lines.length, all.length + 1);
  assert.ok(lines.some((l) => l.includes('"VPS, main box"')), 'comma label is quoted');
  assert.ok(lines.some((l) => l.startsWith('2026-10-10,domains,auto,') && l.endsWith(',10.46')));
  assert.ok(!csv.includes('voided.com'));
});

check('series: daily/weekly/monthly granularity + bucket totals', () => {
  const daily = finance.series(db, period);
  assert.equal(daily.granularity, 'daily');
  assert.equal(daily.buckets.length, 31);
  const b10 = daily.buckets.find((b) => b.start === '2026-10-10');
  assert.equal(b10.byCategory.domains, 1046);
  assert.equal(b10.totalCents, 1046 + (b10.byCategory.other || 0) + (b10.byCategory.calls || 0));
  const weekly = finance.series(db, finance.resolvePeriod({ preset: 'custom', from: '2026-01-01', to: '2026-12-31' }));
  assert.equal(weekly.granularity, 'weekly');
  const monthly = finance.series(db, finance.resolvePeriod({ preset: 'custom', from: '2024-01-01', to: '2026-10-31' }));
  assert.equal(monthly.granularity, 'monthly');
});

checkAsync('role guard: member session and token callers are denied owner/admin', async () => {
  const guard = middleware.requireRole('owner', 'admin');
  const run = (auth) =>
    new Promise((resolve) => {
      const res = {
        code: null,
        status(c) {
          this.code = c;
          return this;
        },
        json() {
          resolve({ denied: true, code: this.code });
        },
      };
      guard({ auth }, res, () => resolve({ denied: false }));
    });
  return Promise.all([
    run({ via: 'session', role: 'member' }),
    run({ via: 'token', role: 'token' }),
    run({ via: 'session', role: 'owner' }),
  ]).then(([member, token, owner]) => {
    assert.equal(member.denied, true);
    assert.equal(member.code, 403);
    assert.equal(token.denied, true);
    assert.equal(owner.denied, false);
    // Structural pins: the finance mutation routes carry the guard.
    const src = fs.readFileSync(path.join(root, 'server/routes/domainApi.js'), 'utf8');
    assert.match(src, /router\.post\('\/admin-area\/finance\/expenses', requireRole\('owner', 'admin'\), denyLeadScopedToken/);
    assert.match(src, /'\/admin-area\/finance\/expenses\/:id',\s*requireRole\('owner', 'admin'\),\s*denyLeadScopedToken/);
    // Batch 62 supersedes the Batch 49-era pin that read routes were
    // token-accessible: the finance GETs now carry the same role gate.
    assert.match(src, /router\.get\('\/admin-area\/finance\/summary', requireRole\('owner', 'admin'\), denyLeadScopedToken/);
    assert.match(src, /router\.get\('\/admin-area\/finance\/ledger', requireRole\('owner', 'admin'\), denyLeadScopedToken/);
    assert.match(src, /router\.get\('\/admin-area\/finance\/export\.csv', requireRole\('owner', 'admin'\), denyLeadScopedToken/);
  });
});

check('empty workspace reports honest zeros', () => {
  const empty = makeDb();
  const s = finance.summary(empty, finance.resolvePeriod({ preset: '30d' }, new Date('2026-10-28T12:00:00Z')));
  assert.equal(s.totalExpenditureCents, 0);
  assert.equal(s.categories.ai.calls, 0);
  assert.equal(s.categories.domains.txnCount, 0);
  assert.equal(s.collected.cents, 0);
  const led = finance.ledger(empty, s.period, {});
  assert.equal(led.total, 0);
  assert.deepEqual(led.rows, []);
});

// Run the async checks, then report.
(async () => {
  for (const [name, fn] of asyncChecks) {
    await fn();
    results.push(name);
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.length,
      names: results,
      negativeMode: process.env.B49_NEGATIVE === '1',
    })
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
