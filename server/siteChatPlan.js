'use strict';

/**
 * The PLANNER's artifact store for the portal design chat
 * (Batch 98 — four-role rebuild step 1, review §12.1/§13).
 *
 * Before this batch a "plan" existed only as prose inside a
 * model turn: the classifier routed, the improve loop improvised,
 * and success was whatever the loop's `mutated` flag said. The
 * rebuild makes the plan a first-class, PERSISTED object:
 *
 *   { intent: 'change',
 *     scope: { pages: ['all'], sections: null },
 *     settled: ['dimension: value', ...],
 *     defaultsApplied: ['...', ...],
 *     steps: [{ tool, args, expect }, ...],
 *     verify: [{ kind: 'computedStyle', selector, property, equals, where }
 *              | { kind: 'presence', text }
 *              | { kind: 'noCollateral' }],
 *     size: 'small' | 'big', route: 'in-chat' | 'queued' }
 *
 * The Planner (museAgent.planPortalChange) emits it; this module
 * validates + normalizes it (a plan whose steps name tools
 * outside the design-scoped allowlist is NOT a plan — it is
 * rejected whole, never silently trimmed into a different plan),
 * persists it per site (site_chat_plans, keyed by lead like every
 * chat-state store), and renders it for queued jobs so the plan —
 * not a paraphrase — is the design job's spec.
 *
 * Batch 99 adds the review_json column (critic evidence + the
 * reviewer's decision ride the same row the plan lives on).
 */

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_chat_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      route TEXT NOT NULL DEFAULT 'in-chat',
      size TEXT NOT NULL DEFAULT 'small',
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}',
      job_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_site_chat_plans_lead ON site_chat_plans(lead_id, id);
  `);
  // Batch 99 migration — critic/reviewer evidence per plan.
  try {
    const stmt = db.prepare('PRAGMA table_info(site_chat_plans)');
    const cols = (stmt && typeof stmt.all === 'function' ? stmt.all() : []).map((c) => c.name);
    if (cols.length && !cols.includes('review_json')) {
      db.exec("ALTER TABLE site_chat_plans ADD COLUMN review_json TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* schema probe unavailable — fresh tables get the column above on next ensure */
  }
}

const MAX_STEPS = 24;
const MAX_VERIFY = 16;

function cleanString(v, cap) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, cap);
}

function cleanStringList(v, cap, itemCap) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => cleanString(s, itemCap)).filter(Boolean).slice(0, cap);
}

function cleanSelector(raw) {
  const s = cleanString(raw, 120);
  if (!s || /[{}<>;]/.test(s)) return null;
  return s;
}

function cleanVerifyCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '');
  if (kind === 'noCollateral') return { kind: 'noCollateral' };
  if (kind === 'presence') {
    const text = cleanString(raw.text, 200);
    return text ? { kind: 'presence', text } : null;
  }
  if (kind === 'computedStyle') {
    const selector = cleanSelector(raw.selector);
    const property = cleanString(raw.property, 40).toLowerCase();
    const equals = cleanString(raw.equals, 120);
    if (!selector || !property || !equals) return null;
    const where = ['light', 'dark', 'all'].includes(String(raw.where || '').toLowerCase())
      ? String(raw.where).toLowerCase()
      : 'all';
    return { kind: 'computedStyle', selector, property, equals, where };
  }
  return null;
}

/**
 * Validate + normalize a raw planner emission. `allowedTools` is
 * the design-scoped allowlist (Set of tool names): a step naming
 * anything else invalidates the WHOLE plan (returns null) — the
 * caller falls back rather than executing a trimmed plan the
 * planner never wrote. Returns the canonical plan object.
 */
function validatePlan(raw, allowedTools) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.steps) || !raw.steps.length) return null;
  const steps = [];
  for (const s of raw.steps.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== 'object') return null;
    const tool = cleanString(s.tool, 80);
    if (!tool || (allowedTools && !allowedTools.has(tool))) return null;
    let args = {};
    if (s.args && typeof s.args === 'object' && !Array.isArray(s.args)) {
      try {
        args = JSON.parse(JSON.stringify(s.args));
      } catch {
        return null;
      }
      if (JSON.stringify(args).length > 4000) return null;
    }
    steps.push({ tool, args, expect: cleanString(s.expect, 300) });
  }
  if (!steps.length) return null;
  const verify = [];
  for (const c of Array.isArray(raw.verify) ? raw.verify.slice(0, MAX_VERIFY) : []) {
    const cleaned = cleanVerifyCheck(c);
    if (cleaned) verify.push(cleaned);
  }
  if (!verify.some((c) => c.kind === 'noCollateral')) verify.push({ kind: 'noCollateral' });
  const scopeRaw = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  // Slug normalization (Batch 99 fix 2): planners emit page
  // references URL-style ("/wedding-cake-tastings") while the
  // site's canonical slugs are bare ("wedding-cake-tastings").
  // Normalize at validation so scope comparisons in the critic
  // (and everywhere downstream) compare like with like.
  const pages = cleanStringList(scopeRaw.pages, 30, 60).map((s) =>
    s === 'all' ? s : s.replace(/^\//, '').replace(/\.html$/, '')
  );
  const size = raw.size === 'big' ? 'big' : 'small';
  return {
    intent: 'change',
    scope: {
      pages: pages.length ? pages : ['all'],
      sections: cleanStringList(scopeRaw.sections, 12, 60).length
        ? cleanStringList(scopeRaw.sections, 12, 60)
        : null,
    },
    settled: cleanStringList(raw.settled, 20, 200),
    defaultsApplied: cleanStringList(raw.defaultsApplied, 12, 240),
    steps,
    verify,
    size,
    route: size === 'big' ? 'queued' : 'in-chat',
  };
}

function rowToPlan(row) {
  if (!row) return null;
  let plan = null;
  try {
    plan = JSON.parse(row.plan_json || '{}');
  } catch {
    plan = null;
  }
  let review = null;
  if (row.review_json) {
    try {
      review = JSON.parse(row.review_json);
    } catch {
      review = null;
    }
  }
  return {
    id: Number(row.id),
    leadId: Number(row.lead_id),
    route: row.route || 'in-chat',
    size: row.size || 'small',
    status: row.status || 'planned',
    jobId: row.job_id != null ? Number(row.job_id) : null,
    plan,
    review,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function savePlan(db, { leadId, plan, jobId = null } = {}) {
  ensureTable(db);
  const info = db
    .prepare(
      `INSERT INTO site_chat_plans (lead_id, route, size, status, plan_json, job_id)
       VALUES (?, ?, ?, 'planned', ?, ?)`
    )
    .run(
      Number(leadId),
      plan && plan.route ? plan.route : 'in-chat',
      plan && plan.size ? plan.size : 'small',
      JSON.stringify(plan || {}),
      jobId != null ? Number(jobId) : null
    );
  return getPlan(db, Number(info.lastInsertRowid));
}

function getPlan(db, id) {
  ensureTable(db);
  const row = db.prepare('SELECT * FROM site_chat_plans WHERE id = ?').get(Number(id));
  return rowToPlan(row);
}

/** This site's most recent plan — strictly per lead. */
function latestPlan(db, leadId) {
  ensureTable(db);
  const row = db
    .prepare('SELECT * FROM site_chat_plans WHERE lead_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(leadId));
  return rowToPlan(row);
}

function setPlanStatus(db, id, status, { jobId } = {}) {
  ensureTable(db);
  if (jobId != null) {
    db.prepare(
      "UPDATE site_chat_plans SET status = ?, job_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(String(status), Number(jobId), Number(id));
  } else {
    db.prepare("UPDATE site_chat_plans SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      String(status),
      Number(id)
    );
  }
  return getPlan(db, id);
}

/** Replace a plan's object in place (replans keep the same row's lineage via review notes). */
function replacePlan(db, id, plan) {
  ensureTable(db);
  db.prepare(
    "UPDATE site_chat_plans SET plan_json = ?, size = ?, route = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    JSON.stringify(plan || {}),
    plan && plan.size ? plan.size : 'small',
    plan && plan.route ? plan.route : 'in-chat',
    Number(id)
  );
  return getPlan(db, id);
}

/** Batch 99 — persist critic + reviewer evidence on the plan row. */
function setPlanReview(db, id, review) {
  ensureTable(db);
  db.prepare("UPDATE site_chat_plans SET review_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(review || {}),
    Number(id)
  );
  return getPlan(db, id);
}

/**
 * The plan rendered as binding job instructions. For a queued
 * (big) job the plan IS the spec: the claiming agent reads the
 * steps and the verify checks verbatim — no re-interpretation,
 * no paraphrase layer between the planner and the builder.
 */
function renderPlanForJob(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const lines = [
    'PLAN (binding — written by the planner; implement exactly these steps, then make sure every verify check passes):',
    `Scope: pages ${Array.isArray(plan.scope && plan.scope.pages) ? plan.scope.pages.join(', ') : 'all'}${
      plan.scope && plan.scope.sections ? `; sections: ${plan.scope.sections.join(', ')}` : ''
    }`,
  ];
  if (Array.isArray(plan.settled) && plan.settled.length) {
    lines.push('Settled decisions (binding):', ...plan.settled.map((s) => `- ${s}`));
  }
  if (Array.isArray(plan.defaultsApplied) && plan.defaultsApplied.length) {
    lines.push('Defaults applied by the planner:', ...plan.defaultsApplied.map((s) => `- ${s}`));
  }
  lines.push('Steps:');
  (plan.steps || []).forEach((s, i) => {
    const args = s.args && Object.keys(s.args).length ? ` with ${JSON.stringify(s.args).slice(0, 600)}` : '';
    lines.push(`${i + 1}. ${s.tool}${args}${s.expect ? ` — expect: ${s.expect}` : ''}`);
  });
  const checks = (plan.verify || []).filter((c) => c.kind !== 'noCollateral');
  if (checks.length) {
    lines.push('Verify before you finish (the platform re-checks these mechanically after delivery):');
    for (const c of checks) {
      if (c.kind === 'computedStyle') {
        lines.push(`- every ${c.selector} must compute ${c.property} = ${c.equals}${c.where && c.where !== 'all' ? ` on ${c.where} sections` : ''}`);
      } else if (c.kind === 'presence') {
        lines.push(`- the text "${c.text}" must be present on the site`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  ensureTable,
  validatePlan,
  savePlan,
  getPlan,
  latestPlan,
  setPlanStatus,
  replacePlan,
  setPlanReview,
  renderPlanForJob,
};
