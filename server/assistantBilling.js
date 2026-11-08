// @ts-check
'use strict';

/**
 * Batch 161 — Assistant chat billing: the monthly rollup + the
 * Stripe landing for the SEPARATE "AI assistant usage" charge
 * (Ely: API costs from this chat are recorded and billed to the
 * user separately, at raw cost plus the admin-set margin).
 *
 * Landing mechanics (honest version): the platform's billing is
 * subscription-based and had NO invoice-item creation anywhere, so
 * the rollup lands the way Stripe itself supports for exactly
 * this: a pending INVOICE ITEM on the workspace billing owner's
 * Stripe customer. Stripe attaches pending invoice items to the
 * customer's NEXT subscription invoice automatically — the usage
 * charge therefore appears as its own line ("AI assistant usage —
 * <month>"), distinct from the plan subscription, without touching
 * any subscription. Creation runs through the platform Stripe
 * client in its CURRENT mode (test-aligned today; nothing here
 * flips a mode or creates live prices) with a deterministic
 * idempotency key, so a retried queue can never double-charge.
 *
 * A rollup with no Stripe customer (or Stripe unconfigured, or a
 * zero total) stays 'accrued' with the reason recorded — the
 * amounts are never lost, and an admin can queue it later from
 * Admin → API keys once a customer exists.
 */

const assistant = require('./assistantChat');

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Recompute + store the month's rollup from ai_usage (portal surface only — staff is internal cost, never billed). */
function computeRollup(db, month) {
  assistant.ensureTables(db);
  assistant.ensureUsageColumns(db);
  let raw = 0;
  let billed = 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(raw_cost_usd), 0) AS r, COALESCE(SUM(billed_usd), 0) AS b
         FROM ai_usage WHERE task = 'assistant_chat' AND surface = 'portal' AND substr(at, 1, 7) = ?`
      )
      .get(String(month));
    raw = Number(row.r) || 0;
    billed = Number(row.b) || 0;
  } catch {
    /* fresh workspace — zeros */
  }
  const existing = db.prepare('SELECT * FROM assistant_usage_rollups WHERE month = ?').get(String(month));
  if (existing && (existing.status === 'queued' || existing.status === 'invoiced')) {
    // A queued rollup is frozen — recompute is reported but never
    // rewrites a charge already placed on the customer.
    return {
      month,
      rawUsd: Number(existing.raw_usd) || 0,
      billedUsd: Number(existing.billed_usd) || 0,
      status: existing.status,
      stripeInvoiceItemId: existing.stripe_invoice_item_id || null,
      note: existing.note || null,
      liveRawUsd: raw,
      liveBilledUsd: billed,
      frozen: true,
    };
  }
  db.prepare(
    `INSERT INTO assistant_usage_rollups (month, raw_usd, billed_usd, status)
     VALUES (?, ?, ?, 'accrued')
     ON CONFLICT(month) DO UPDATE SET raw_usd = excluded.raw_usd, billed_usd = excluded.billed_usd, updated_at = datetime('now')`
  ).run(String(month), raw, billed);
  return { month, rawUsd: raw, billedUsd: billed, status: 'accrued', stripeInvoiceItemId: null, note: null, frozen: false };
}

/** The workspace billing owner's Stripe customer id (same owner resolution portalBilling uses). */
async function workspaceStripeCustomer(workspaceId) {
  const { query } = require('./db');
  const rows = await query(
    `SELECT u.id, u.email, u.stripe_customer_id
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :ws AND m.role IN ('owner','admin')
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.id ASC`,
    { ws: Number(workspaceId) }
  );
  const withCustomer = (rows || []).find((u) => u.stripe_customer_id);
  return withCustomer ? String(withCustomer.stripe_customer_id) : null;
}

/**
 * Queue one month's rollup onto the customer's next invoice as a
 * pending invoice item. Idempotent per (workspace, month).
 */
async function queueRollupForInvoice(workspaceId, month) {
  const domain = require('./domain');
  const rollup = domain.withDb(workspaceId, (db) => computeRollup(db, month));
  if (rollup.status === 'queued' || rollup.status === 'invoiced') {
    return { ...rollup, queued: rollup.status === 'queued', already: true };
  }
  const amountCents = Math.round(Number(rollup.billedUsd) * 100);
  const mark = (status, itemId, note) =>
    domain.withDb(workspaceId, (db) => {
      db.prepare(
        `UPDATE assistant_usage_rollups SET status = ?, stripe_invoice_item_id = ?, note = ?, updated_at = datetime('now') WHERE month = ?`
      ).run(status, itemId || null, note ? String(note).slice(0, 300) : null, String(month));
      return db.prepare('SELECT * FROM assistant_usage_rollups WHERE month = ?').get(String(month));
    });
  if (amountCents <= 0) {
    const row = mark('accrued', null, 'Zero billed total — nothing to queue.');
    return { month, rawUsd: rollup.rawUsd, billedUsd: rollup.billedUsd, status: row.status, queued: false, reason: 'zero_amount' };
  }
  const customer = await workspaceStripeCustomer(workspaceId);
  if (!customer) {
    const row = mark('accrued', null, 'No Stripe customer for this workspace yet — accrues until one exists.');
    return { month, rawUsd: rollup.rawUsd, billedUsd: rollup.billedUsd, status: row.status, queued: false, reason: 'no_stripe_customer' };
  }
  const { getStripe } = require('./stripeClient');
  const stripe = await getStripe();
  if (!stripe) {
    return { month, rawUsd: rollup.rawUsd, billedUsd: rollup.billedUsd, status: 'accrued', queued: false, reason: 'stripe_not_configured' };
  }
  const { stripeIdempotencyKey } = require('./stripeIdempotency');
  const item = await stripe.invoiceItems.create(
    {
      customer,
      amount: amountCents,
      currency: 'usd',
      description: `AI assistant usage — ${month}`,
      metadata: { kind: 'assistant_usage', workspace_id: String(workspaceId), month: String(month) },
    },
    { idempotencyKey: stripeIdempotencyKey('assistant-usage', `${workspaceId}-${month}`) }
  );
  const row = mark('queued', item && item.id ? String(item.id) : null, null);
  return {
    month,
    rawUsd: Number(row.raw_usd) || 0,
    billedUsd: Number(row.billed_usd) || 0,
    status: row.status,
    stripeInvoiceItemId: row.stripe_invoice_item_id || null,
    queued: true,
  };
}

/** Cross-workspace month overview for Admin (per workspace + staff-internal split). */
async function adminUsageOverview(month) {
  const { query } = require('./db');
  const { openWorkspaceDb } = require('./workspaceDb');
  const workspaces = await query('SELECT id, name FROM workspaces ORDER BY id ASC');
  const rows = [];
  const totals = { rawUsd: 0, billedUsd: 0, staffRawUsd: 0, calls: 0 };
  for (const ws of workspaces || []) {
    let s = null;
    try {
      const db = openWorkspaceDb(Number(ws.id));
      if (db) s = assistant.usageSummary(db, { month });
    } catch {
      s = null;
    }
    const row = {
      workspaceId: Number(ws.id),
      name: ws.name || '',
      portalRawUsd: s ? s.portal.rawUsd : 0,
      portalBilledUsd: s ? s.portal.billedUsd : 0,
      portalCalls: s ? s.portal.calls : 0,
      staffRawUsd: s ? s.admin.rawUsd : 0,
      staffCalls: s ? s.admin.calls : 0,
      rollup: s ? s.rollup : null,
    };
    totals.rawUsd += row.portalRawUsd;
    totals.billedUsd += row.portalBilledUsd;
    totals.staffRawUsd += row.staffRawUsd;
    totals.calls += row.portalCalls + row.staffCalls;
    rows.push(row);
  }
  return { month, rows, totals };
}

module.exports = { computeRollup, queueRollupForInvoice, workspaceStripeCustomer, adminUsageOverview };
