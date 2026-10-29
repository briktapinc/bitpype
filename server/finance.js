'use strict';

/**
 * Batch 49 — Admin Finance dashboard engine (workspace SQLite).
 *
 * Aggregates the expenditure the app actually records, over a period:
 *   - Domains: domain_transactions.registrar_price_cents (the ACTUAL
 *     Cloudflare registrar cost) on transactions whose registration
 *     completed — SPENT_TXN_STATUSES. Pending/failed/voided money never
 *     left the Cloudflare account, so it never counts as spent.
 *   - AI: ai_usage.cost_usd — every AI call is already logged by src/ai.js
 *     with token counts and a rate×token cost ESTIMATE. Figures derived
 *     from it are labeled "estimated" everywhere they surface.
 *   - Everything else (Cloudflare Workers plan, hosting, Twilio top-ups,
 *     Mailjet bills…) has no app-side record, so it enters through manual
 *     expense rows (finance_expenses) — the only honest door for it.
 *
 * HONESTY RULE: this module never invents a cost. A category with no
 * recorded data reports 0, and estimates are always flagged as estimates.
 *
 * Dates: all stored timestamps are UTC (datetime('now')); period bounds
 * are UTC calendar dates, inclusive on both ends — the same convention
 * the rest of admin reporting uses (date(at) = date('now')).
 */

const { pageArgs, pageResult } = require('../src/paginate');

const CATEGORIES = ['domains', 'ai', 'cloudflare', 'hosting', 'calls', 'email', 'other'];
const CATEGORY_LABELS = {
  domains: 'Domains',
  ai: 'AI',
  cloudflare: 'Cloudflare',
  hosting: 'Hosting',
  calls: 'Calls / Twilio',
  email: 'Email',
  other: 'Other',
};

/**
 * Transaction statuses whose registrar charge actually happened.
 * Exported (and read at query time) so regression tests can prove the
 * voided/pending/failed exclusions are load-bearing.
 */
const SPENT_TXN_STATUSES = ['live'];
/** Statuses where the client's money was actually collected. */
const COLLECTED_TXN_STATUSES = ['paid', 'registering', 'live'];

const PRESETS = ['today', '7d', '30d', '90d', '12m', 'mtd', 'custom'];
const MAX_SPAN_DAYS = 366 * 5;

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      note TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON finance_expenses(date);
    CREATE INDEX IF NOT EXISTS idx_finance_expenses_category ON finance_expenses(category);
  `);
}

/** domain_transactions is created lazily by domainFlow; make sure it
 *  exists before aggregating (a fresh workspace may never have opened
 *  the Domains page). Lazy require — same pattern as server/domain.js. */
function ensureDomainTables(db) {
  try {
    require('./domainFlow').ensureTables(db);
  } catch (e) {
    /* domainFlow always ships with this module in practice */
    console.warn('[finance] ensureDomainTables:', e.message || e);
  }
}

// ---------------------------------------------------------------------------
// Period resolution (UTC calendar dates, inclusive both ends)
// ---------------------------------------------------------------------------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDate(d) === s;
}

function spanDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * Resolve {preset, from, to} into an inclusive UTC date range.
 * `now` is injectable for tests (a Date or an ISO date string).
 */
function resolvePeriod(opts = {}, now = new Date()) {
  const today = isoDate(now instanceof Date ? now : new Date(now));
  const preset = String(opts.preset || '30d').toLowerCase();
  if (!PRESETS.includes(preset)) throw fail('INVALID', `Unknown period preset "${preset}".`);
  let from;
  let to = today;
  if (preset === 'today') from = today;
  else if (preset === '7d') from = addDays(today, -6);
  else if (preset === '30d') from = addDays(today, -29);
  else if (preset === '90d') from = addDays(today, -89);
  else if (preset === '12m') from = addDays(today, -364);
  else if (preset === 'mtd') from = `${today.slice(0, 8)}01`;
  else {
    // custom
    from = String(opts.from || '');
    to = String(opts.to || '');
    if (!isIsoDate(from) || !isIsoDate(to)) {
      throw fail('INVALID', 'Custom period needs valid from and to dates (YYYY-MM-DD).');
    }
    if (from > to) throw fail('INVALID', 'Custom period start must be on or before its end.');
  }
  if (spanDays(from, to) > MAX_SPAN_DAYS) {
    throw fail('INVALID', `Period is too long (max ${MAX_SPAN_DAYS} days).`);
  }
  return { preset, from, to };
}

// ---------------------------------------------------------------------------
// Source aggregates
// ---------------------------------------------------------------------------

function statusInSql(statuses) {
  return statuses.map(() => '?').join(', ');
}

function domainSpend(db, period) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(registrar_price_cents), 0) AS cents, COUNT(*) AS n
         FROM domain_transactions
        WHERE status IN (${statusInSql(SPENT_TXN_STATUSES)})
          AND registrar_price_cents IS NOT NULL
          AND date(COALESCE(completed_at, paid_at, created_at)) BETWEEN ? AND ?`
    )
    .get(...SPENT_TXN_STATUSES, period.from, period.to);
  return { cents: Number(row.cents) || 0, count: Number(row.n) || 0 };
}

function domainCollected(db, period) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paid_cents), 0) AS cents, COUNT(*) AS n
         FROM domain_transactions
        WHERE status IN (${statusInSql(COLLECTED_TXN_STATUSES)})
          AND amount_paid_cents IS NOT NULL
          AND date(COALESCE(paid_at, created_at)) BETWEEN ? AND ?`
    )
    .get(...COLLECTED_TXN_STATUSES, period.from, period.to);
  return { cents: Number(row.cents) || 0, count: Number(row.n) || 0 };
}

function aiSpend(db, period) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM ai_usage
        WHERE date(at) BETWEEN ? AND ?`
    )
    .get(period.from, period.to);
  const byTask = db
    .prepare(
      `SELECT task, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls
         FROM ai_usage WHERE date(at) BETWEEN ? AND ? GROUP BY task ORDER BY usd DESC`
    )
    .all(period.from, period.to)
    .map((r) => ({ key: r.task, cents: Math.round(Number(r.usd) * 100), calls: Number(r.calls) || 0 }));
  const byModel = db
    .prepare(
      `SELECT model, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls
         FROM ai_usage WHERE date(at) BETWEEN ? AND ? GROUP BY model ORDER BY usd DESC`
    )
    .all(period.from, period.to)
    .map((r) => ({ key: r.model, cents: Math.round(Number(r.usd) * 100), calls: Number(r.calls) || 0 }));
  return {
    usd: Number(row.usd) || 0,
    cents: Math.round((Number(row.usd) || 0) * 100),
    calls: Number(row.calls) || 0,
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    byTask,
    byModel,
  };
}

function manualByCategory(db, period) {
  ensureTables(db);
  const rows = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n
         FROM finance_expenses WHERE date BETWEEN ? AND ? GROUP BY category`
    )
    .all(period.from, period.to);
  const out = {};
  for (const c of CATEGORIES) out[c] = { cents: 0, count: 0 };
  for (const r of rows) {
    if (out[r.category]) out[r.category] = { cents: Number(r.cents) || 0, count: Number(r.n) || 0 };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summary(db, period) {
  ensureDomainTables(db);
  const domainsAuto = domainSpend(db, period);
  const ai = aiSpend(db, period);
  const manual = manualByCategory(db, period);
  const collected = domainCollected(db, period);

  const categories = {};
  for (const c of CATEGORIES) {
    const autoCents = c === 'domains' ? domainsAuto.cents : c === 'ai' ? ai.cents : 0;
    categories[c] = {
      label: CATEGORY_LABELS[c],
      autoCents,
      manualCents: manual[c].cents,
      totalCents: autoCents + manual[c].cents,
      manualCount: manual[c].count,
    };
  }
  categories.domains.txnCount = domainsAuto.count;
  categories.ai.calls = ai.calls;
  categories.ai.promptTokens = ai.promptTokens;
  categories.ai.completionTokens = ai.completionTokens;
  categories.ai.estimated = true;
  categories.ai.byTask = ai.byTask;
  categories.ai.byModel = ai.byModel;

  const totalExpenditureCents = CATEGORIES.reduce((sum, c) => sum + categories[c].totalCents, 0);
  return {
    period,
    categories,
    totalExpenditureCents,
    collected: {
      cents: collected.cents,
      count: collected.count,
      source: 'domain_transactions.amount_paid_cents (paid/registering/live)',
      label: 'Collected — domain checkouts',
    },
    aiNote:
      'AI figures are estimates: each call is logged with a rate × token cost estimate (see Settings → AI costs), not an invoice from the provider.',
  };
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

function bucketPlan(period) {
  const span = spanDays(period.from, period.to);
  const granularity = span <= 92 ? 'daily' : span <= 371 ? 'weekly' : 'monthly';
  const buckets = [];
  if (granularity === 'daily') {
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) {
      buckets.push({ start: d, end: d, label: d });
    }
  } else if (granularity === 'weekly') {
    for (let d = period.from; d <= period.to; d = addDays(d, 7)) {
      const end = addDays(d, 6) > period.to ? period.to : addDays(d, 6);
      buckets.push({ start: d, end, label: d });
    }
  } else {
    let cur = `${period.from.slice(0, 8)}01`;
    if (cur < period.from) cur = period.from;
    while (cur <= period.to) {
      const monthStart = `${cur.slice(0, 8)}01`;
      const next = addDays(`${monthStart.slice(0, 8)}28`, 4);
      const nextMonth = `${next.slice(0, 8)}01`;
      const end = addDays(nextMonth, -1) > period.to ? period.to : addDays(nextMonth, -1);
      buckets.push({ start: cur, end, label: cur.slice(0, 7) });
      cur = nextMonth;
    }
  }
  return { granularity, buckets };
}

function series(db, period) {
  ensureDomainTables(db);
  const { granularity, buckets } = bucketPlan(period);
  const idx = new Map();
  buckets.forEach((b, i) => {
    for (let d = b.start; d <= b.end; d = addDays(d, 1)) idx.set(d, i);
  });
  const zero = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const sums = buckets.map(() => zero());
  const add = (dateStr, category, cents) => {
    const i = idx.get(dateStr);
    if (i != null && sums[i][category] != null) sums[i][category] += cents;
  };

  for (const r of db
    .prepare(
      `SELECT date(COALESCE(completed_at, paid_at, created_at)) AS d,
              COALESCE(SUM(registrar_price_cents), 0) AS cents
         FROM domain_transactions
        WHERE status IN (${statusInSql(SPENT_TXN_STATUSES)})
          AND registrar_price_cents IS NOT NULL
          AND date(COALESCE(completed_at, paid_at, created_at)) BETWEEN ? AND ?
        GROUP BY d`
    )
    .all(...SPENT_TXN_STATUSES, period.from, period.to)) {
    add(r.d, 'domains', Number(r.cents) || 0);
  }
  for (const r of db
    .prepare(
      `SELECT date(at) AS d, COALESCE(SUM(cost_usd), 0) AS usd
         FROM ai_usage WHERE date(at) BETWEEN ? AND ? GROUP BY d`
    )
    .all(period.from, period.to)) {
    add(r.d, 'ai', Math.round((Number(r.usd) || 0) * 100));
  }
  ensureTables(db);
  for (const r of db
    .prepare(
      `SELECT date AS d, category, COALESCE(SUM(amount_cents), 0) AS cents
         FROM finance_expenses WHERE date BETWEEN ? AND ? GROUP BY d, category`
    )
    .all(period.from, period.to)) {
    add(r.d, r.category, Number(r.cents) || 0);
  }

  return {
    granularity,
    buckets: buckets.map((b, i) => ({
      ...b,
      byCategory: sums[i],
      totalCents: CATEGORIES.reduce((s, c) => s + sums[i][c], 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// Unified ledger (auto domain rows + AI daily aggregates + manual rows)
// ---------------------------------------------------------------------------

function ledgerUnionSql() {
  return `
    SELECT d, category, source, label, amount_cents, ref_id FROM (
      SELECT date(COALESCE(completed_at, paid_at, created_at)) AS d,
             'domains' AS category, 'auto' AS source,
             ('Domain registration — ' || domain || ' (' || plan_id || ')') AS label,
             registrar_price_cents AS amount_cents, id AS ref_id
        FROM domain_transactions
       WHERE status IN (${statusInSql(SPENT_TXN_STATUSES)})
         AND registrar_price_cents IS NOT NULL
      UNION ALL
      SELECT d, 'ai', 'auto', label, amount_cents, NULL FROM (
        SELECT date(at) AS d,
               ('AI usage — ' || COUNT(*) || ' calls (estimated)') AS label,
               CAST(ROUND(SUM(cost_usd) * 100) AS INTEGER) AS amount_cents
          FROM ai_usage GROUP BY date(at)
      )
      UNION ALL
      SELECT date AS d, category, 'manual' AS source, label, amount_cents, id AS ref_id
        FROM finance_expenses
    )`;
}

function ledger(db, period, opts = {}) {
  ensureTables(db);
  ensureDomainTables(db);
  const category = opts.category && CATEGORIES.includes(opts.category) ? opts.category : null;
  const { page, pageSize, offset } = pageArgs(opts, { pageSize: 25 });
  const where = ` WHERE d BETWEEN ? AND ?${category ? ' AND category = ?' : ''}`;
  const params = category ? [period.from, period.to, category] : [period.from, period.to];
  const union = ledgerUnionSql();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${union})${where}`).get(...SPENT_TXN_STATUSES, ...params).n;
  const rows = db
    .prepare(`${union}${where} ORDER BY d DESC, source ASC, ref_id DESC LIMIT ? OFFSET ?`)
    .all(...SPENT_TXN_STATUSES, ...params, pageSize, offset)
    .map((r) => ({
      date: r.d,
      category: r.category,
      categoryLabel: CATEGORY_LABELS[r.category] || r.category,
      source: r.source,
      label: r.label,
      amountCents: Number(r.amount_cents) || 0,
      refId: r.ref_id,
      deletable: r.source === 'manual',
    }));
  return pageResult(rows, total, page, pageSize);
}

/** All ledger rows for a period+filter (CSV export), capped. */
function ledgerAll(db, period, opts = {}) {
  ensureTables(db);
  ensureDomainTables(db);
  const category = opts.category && CATEGORIES.includes(opts.category) ? opts.category : null;
  const where = ` WHERE d BETWEEN ? AND ?${category ? ' AND category = ?' : ''}`;
  const params = category ? [period.from, period.to, category] : [period.from, period.to];
  return db
    .prepare(`${ledgerUnionSql()}${where} ORDER BY d ASC, source ASC, ref_id ASC LIMIT 10000`)
    .all(...SPENT_TXN_STATUSES, ...params)
    .map((r) => ({
      date: r.d,
      category: r.category,
      source: r.source,
      label: r.label,
      amountCents: Number(r.amount_cents) || 0,
    }));
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ledgerCsv(db, period, opts = {}) {
  const rows = ledgerAll(db, period, opts);
  const lines = ['date,category,source,label,amount_usd'];
  for (const r of rows) {
    lines.push(
      [r.date, r.category, r.source, csvEscape(r.label), (r.amountCents / 100).toFixed(2)].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Manual expenses
// ---------------------------------------------------------------------------

function publicExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    label: row.label,
    amountCents: row.amount_cents,
    note: row.note || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function addExpense(db, input = {}) {
  ensureTables(db);
  const date = String(input.date || '');
  if (!isIsoDate(date)) throw fail('INVALID', 'Expense date must be a valid date (YYYY-MM-DD).');
  const category = String(input.category || '');
  if (!CATEGORIES.includes(category)) {
    throw fail('INVALID', `Category must be one of: ${CATEGORIES.join(', ')}.`);
  }
  const label = String(input.label || '').trim();
  if (!label) throw fail('INVALID', 'Expense label is required.');
  if (label.length > 200) throw fail('INVALID', 'Expense label is too long (max 200 chars).');
  const amountCents = Number(input.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw fail('INVALID', 'Expense amount must be a positive whole number of cents.');
  }
  const note = input.note == null ? '' : String(input.note).slice(0, 1000);
  const createdBy = input.createdBy != null && Number.isInteger(Number(input.createdBy)) ? Number(input.createdBy) : null;
  const res = db
    .prepare(
      `INSERT INTO finance_expenses (date, category, label, amount_cents, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(date, category, label, amountCents, note || null, createdBy);
  return publicExpense(db.prepare('SELECT * FROM finance_expenses WHERE id = ?').get(res.lastInsertRowid));
}

function deleteExpense(db, id) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM finance_expenses WHERE id = ?').get(Number(id));
  if (!row) throw fail('NOT_FOUND', `Finance expense #${id} not found.`);
  db.prepare('DELETE FROM finance_expenses WHERE id = ?').run(row.id);
  return { ok: true, id: row.id, label: row.label, amountCents: row.amount_cents };
}

/**
 * Batch 62 — AI usage by workspace (platform money visibility).
 * The per-workspace Finance summary above only ever sees ONE tenant
 * DB; a hosted platform needs the cross-tenant picture: every
 * workspace's ai_usage for the period, summed with the same aiSpend
 * math (so the two views can never disagree), labeled estimated like
 * every other AI figure. `workspaces` is [{id, name}] from the server
 * DB and `openDb(id)` resolves a tenant DB — a workspace whose DB
 * cannot be opened (or has no ai_usage yet) reports zeros rather than
 * breaking the table, and zero-usage workspaces still get a row.
 */
function aiUsageByWorkspace(period, workspaces, openDb) {
  const rows = [];
  const totals = { calls: 0, promptTokens: 0, completionTokens: 0, tokens: 0, usd: 0, cents: 0, estimated: true };
  for (const ws of workspaces || []) {
    let ai = { usd: 0, cents: 0, calls: 0, promptTokens: 0, completionTokens: 0 };
    try {
      const db = openDb(ws.id);
      if (db) ai = aiSpend(db, period);
    } catch {
      /* zero-usage row below */
    }
    const tokens = (Number(ai.promptTokens) || 0) + (Number(ai.completionTokens) || 0);
    rows.push({
      workspaceId: Number(ws.id),
      name: ws.name || '',
      calls: Number(ai.calls) || 0,
      promptTokens: Number(ai.promptTokens) || 0,
      completionTokens: Number(ai.completionTokens) || 0,
      tokens,
      usd: Number(ai.usd) || 0,
      cents: Number(ai.cents) || 0,
      estimated: true,
    });
    totals.calls += Number(ai.calls) || 0;
    totals.promptTokens += Number(ai.promptTokens) || 0;
    totals.completionTokens += Number(ai.completionTokens) || 0;
    totals.tokens += tokens;
    totals.usd += Number(ai.usd) || 0;
    totals.cents += Number(ai.cents) || 0;
  }
  rows.sort((a, b) => b.cents - a.cents || a.workspaceId - b.workspaceId);
  totals.usd = Math.round(totals.usd * 1e6) / 1e6;
  return { period, rows, totals };
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  SPENT_TXN_STATUSES,
  COLLECTED_TXN_STATUSES,
  PRESETS,
  ensureTables,
  resolvePeriod,
  summary,
  series,
  ledger,
  ledgerAll,
  ledgerCsv,
  addExpense,
  deleteExpense,
  publicExpense,
  aiUsageByWorkspace,
};
