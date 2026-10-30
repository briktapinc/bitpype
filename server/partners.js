'use strict';

/**
 * partners.js — Creator Partner program (Batch 80, Ely's terms
 * 2026-10-30).
 *
 * Partners are platform users with `users.account_type = 'partner'`
 * (admin-created only — registration stays closed; there is no
 * self-serve partner signup). A partner works in the staff app with
 * full staff capability INSIDE their own workspace (membership +
 * requireWorkspace already scope every read/write) and:
 *
 *   - CANNOT change any settings: every settings write denies a
 *     partner session with a coded 403 (PARTNER_SETTINGS_FORBIDDEN),
 *     and platform-admin surfaces stay super-admin-only.
 *   - CANNOT spend money directly: a purchase initiated by a partner
 *     creates an APPROVAL REQUEST instead of executing. An admin
 *     (super-admin) approves → the stored action executes; denies →
 *     closed with the decision recorded. Gated actions:
 *       domain_register        (Cloudflare registrar charge)
 *       call_number_purchase   (Twilio number purchase)
 *       credits_checkout       (credits pack checkout session)
 *       domain_flow_complete   (staff completion of a paid domain
 *                               flow — executes the registration)
 *       hostinger_deploy       (one-click Hostinger deployment start)
 *   - EARNS a commission (platform setting
 *     `partners.commission_percent`, default 30, admin-only) on every
 *     SUBSCRIPTION payment collected from customers in the partner's
 *     workspace. Credited from the billing webhook's invoice.paid
 *     branch, exactly once per invoice (the ledger's UNIQUE
 *     credit_key, in the spirit of the lifecycle-comms claim
 *     pattern). Refunds reverse proportionally; disputes reverse the
 *     remaining credit. Free-plan ($0) payments credit nothing.
 *   - PAYOUTS are monthly and manual: a partner is payout-eligible
 *     when their accrued, unreversed balance reaches $500. An admin
 *     records a payout in the app (method + note); the actual money
 *     movement happens outside the app. Payouts are GROSS — partners
 *     are responsible for their own taxes (stated in the UI copy).
 *
 * Attribution: a payment belongs to a workspace when the invoice's
 * subscription matches a `domain_transactions` row in that workspace
 * (the Batch 69 spine); fallback: the paying user is a member of
 * exactly one workspace that has a partner, and is not that partner.
 *
 * All state lives in the PLATFORM database (users/workspaces are
 * platform rows): partner_earnings (ledger), partner_payouts,
 * partner_approval_requests.
 */

const { query, driver } = require('./db');

const DEFAULT_RATE_PERCENT = 30;
const RATE_SETTING_KEY = 'partners.commission_percent';
const PAYOUT_THRESHOLD_CENTS = 50000; // $500

const ACTION_KINDS = [
  'domain_register',
  'call_number_purchase',
  'credits_checkout',
  'domain_flow_complete',
  'hostinger_deploy',
];

let tablesReady = false;

async function ensurePartnerTables() {
  if (tablesReady) return;
  if (driver === 'mysql') {
    await query(
      `CREATE TABLE IF NOT EXISTS partner_earnings (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         partner_user_id BIGINT UNSIGNED NOT NULL,
         workspace_id BIGINT UNSIGNED NULL,
         kind VARCHAR(16) NOT NULL DEFAULT 'credit',
         amount_cents INT NOT NULL DEFAULT 0,
         currency VARCHAR(8) NOT NULL DEFAULT 'usd',
         credit_key VARCHAR(255) NULL,
         stripe_invoice_id VARCHAR(255) NULL,
         stripe_charge_id VARCHAR(255) NULL,
         payment_id BIGINT UNSIGNED NULL,
         payout_id BIGINT UNSIGNED NULL,
         related_entry_id BIGINT UNSIGNED NULL,
         note VARCHAR(255) NULL,
         created_at VARCHAR(32) NULL,
         UNIQUE KEY uq_partner_earnings_key (credit_key),
         KEY idx_partner_earnings_user (partner_user_id, id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS partner_payouts (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         partner_user_id BIGINT UNSIGNED NOT NULL,
         amount_cents INT NOT NULL DEFAULT 0,
         method VARCHAR(64) NULL,
         note VARCHAR(255) NULL,
         paid_by BIGINT UNSIGNED NULL,
         created_at VARCHAR(32) NULL,
         KEY idx_partner_payouts_user (partner_user_id, id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS partner_approval_requests (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         workspace_id BIGINT UNSIGNED NULL,
         requested_by BIGINT UNSIGNED NOT NULL,
         action_kind VARCHAR(48) NOT NULL,
         payload_json TEXT NULL,
         status VARCHAR(16) NOT NULL DEFAULT 'pending',
         decided_by BIGINT UNSIGNED NULL,
         decided_at VARCHAR(32) NULL,
         result_json TEXT NULL,
         created_at VARCHAR(32) NULL,
         KEY idx_partner_approvals_status (status, id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    tablesReady = true;
    return;
  }
  await query(
    `CREATE TABLE IF NOT EXISTS partner_earnings (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       partner_user_id INTEGER NOT NULL,
       workspace_id INTEGER,
       kind VARCHAR(16) NOT NULL DEFAULT 'credit',
       amount_cents INTEGER NOT NULL DEFAULT 0,
       currency VARCHAR(8) NOT NULL DEFAULT 'usd',
       credit_key VARCHAR(255) UNIQUE,
       stripe_invoice_id VARCHAR(255),
       stripe_charge_id VARCHAR(255),
       payment_id INTEGER,
       payout_id INTEGER,
       related_entry_id INTEGER,
       note VARCHAR(255),
       created_at VARCHAR(32)
     )`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS partner_payouts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       partner_user_id INTEGER NOT NULL,
       amount_cents INTEGER NOT NULL DEFAULT 0,
       method VARCHAR(64),
       note VARCHAR(255),
       paid_by INTEGER,
       created_at VARCHAR(32)
     )`
  );
  await query(
    `CREATE TABLE IF NOT EXISTS partner_approval_requests (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       workspace_id INTEGER,
       requested_by INTEGER NOT NULL,
       action_kind VARCHAR(48) NOT NULL,
       payload_json TEXT,
       status VARCHAR(16) NOT NULL DEFAULT 'pending',
       decided_by INTEGER,
       decided_at VARCHAR(32),
       result_json TEXT,
       created_at VARCHAR(32)
     )`
  );
  tablesReady = true;
}

function isDupError(e) {
  return !!e && (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || '')));
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------- identity ------------------------- */

async function getAccountType(userId) {
  if (!userId) return null;
  const rows = await query('SELECT account_type FROM users WHERE id = :id LIMIT 1', {
    id: Number(userId),
  });
  if (!rows.length) return null;
  return String(rows[0].account_type || 'standard');
}

async function isPartnerUser(userId) {
  if (!userId) return false;
  return (await getAccountType(userId)) === 'partner';
}

/** The partner who operates a workspace (a partner-type member), or null. */
async function partnerOfWorkspace(workspaceId) {
  if (!workspaceId) return null;
  const rows = await query(
    `SELECT u.id, u.email, u.name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = :ws
        AND u.account_type = 'partner'
        AND (u.status IS NULL OR u.status = 'active')
        AND u.deleted_at IS NULL
      ORDER BY CASE WHEN wm.role = 'owner' THEN 0 ELSE 1 END, u.id ASC
      LIMIT 1`,
    { ws: Number(workspaceId) }
  );
  return rows[0] || null;
}

async function workspaceHasPartner(workspaceId) {
  return !!(await partnerOfWorkspace(workspaceId));
}

/** Workspace ids a user belongs to (membership order). */
async function workspacesOfUser(userId) {
  const rows = await query(
    'SELECT workspace_id FROM workspace_members WHERE user_id = :uid ORDER BY workspace_id ASC',
    { uid: Number(userId) }
  );
  return rows.map((r) => Number(r.workspace_id));
}

/* ------------------------- commission rate ------------------------- */

async function commissionRatePercent() {
  try {
    const platform = require('./platform');
    const raw = await platform.getPlatformSetting(RATE_SETTING_KEY, String(DEFAULT_RATE_PERCENT));
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_RATE_PERCENT;
}

function commissionFor(baseCents, ratePercent) {
  const base = Math.round(Number(baseCents) || 0);
  if (base <= 0) return 0;
  return Math.round((base * Number(ratePercent || 0)) / 100);
}

/* ------------------------- earnings ledger ------------------------- */

/**
 * Credit a partner for one collected subscription payment. Exactly
 * once per invoice: the UNIQUE credit_key claim is inserted first and
 * a duplicate key short-circuits — the same claim-then-do shape as
 * lifecycleComms, and a second line of defense behind the payments
 * table's own invoice uniqueness.
 */
async function creditForPayment({
  partnerUserId,
  workspaceId,
  invoiceId,
  chargeId = null,
  paymentId = null,
  baseCents,
  currency = 'usd',
}) {
  await ensurePartnerTables();
  const rate = await commissionRatePercent();
  const amount = commissionFor(baseCents, rate);
  if (!invoiceId) return { credited: false, reason: 'no_invoice' };
  if (amount <= 0) return { credited: false, reason: 'zero_amount' };
  try {
    const r = await query(
      `INSERT INTO partner_earnings
         (partner_user_id, workspace_id, kind, amount_cents, currency, credit_key,
          stripe_invoice_id, stripe_charge_id, payment_id, created_at)
       VALUES (:partner, :ws, 'credit', :amount, :currency, :key, :invoice, :charge, :payment, :at)`,
      {
        partner: Number(partnerUserId),
        ws: workspaceId != null ? Number(workspaceId) : null,
        amount,
        currency: String(currency || 'usd').toLowerCase(),
        key: `inv:${invoiceId}`,
        invoice: String(invoiceId),
        charge: chargeId ? String(chargeId) : null,
        payment: paymentId != null ? Number(paymentId) : null,
        at: nowIso(),
      }
    );
    return { credited: true, amountCents: amount, ratePercent: rate, id: r.insertId };
  } catch (e) {
    if (isDupError(e)) return { credited: false, duplicate: true };
    throw e;
  }
}

async function creditEntryForInvoice(invoiceId) {
  const rows = await query(
    `SELECT * FROM partner_earnings WHERE credit_key = :key AND kind = 'credit' LIMIT 1`,
    { key: `inv:${invoiceId}` }
  );
  return rows[0] || null;
}

async function reversedCentsFor(creditEntryId) {
  const rows = await query(
    `SELECT COALESCE(SUM(-amount_cents), 0) AS total FROM partner_earnings
      WHERE kind = 'reversal' AND related_entry_id = :id`,
    { id: Number(creditEntryId) }
  );
  return Number(rows[0] && rows[0].total) || 0;
}

async function insertReversal({ credit, key, amountCents, note }) {
  try {
    const r = await query(
      `INSERT INTO partner_earnings
         (partner_user_id, workspace_id, kind, amount_cents, currency, credit_key,
          stripe_invoice_id, stripe_charge_id, related_entry_id, note, created_at)
       VALUES (:partner, :ws, 'reversal', :amount, :currency, :key, :invoice, :charge, :related, :note, :at)`,
      {
        partner: Number(credit.partner_user_id),
        ws: credit.workspace_id != null ? Number(credit.workspace_id) : null,
        amount: -Math.abs(Math.round(amountCents)),
        currency: credit.currency || 'usd',
        key,
        invoice: credit.stripe_invoice_id || null,
        charge: credit.stripe_charge_id || null,
        related: Number(credit.id),
        note: note || null,
        at: nowIso(),
      }
    );
    return { reversed: true, id: r.insertId };
  } catch (e) {
    if (isDupError(e)) return { reversed: false, duplicate: true };
    throw e;
  }
}

/**
 * Reverse commission for a refund, proportionally to how much of the
 * charge has been refunded in total (charge.amount_refunded), capped
 * at the credit's unreversed remainder. Exactly once per refund id.
 */
async function reverseForRefund({ refundId, invoiceId, chargeId, chargeAmountCents, amountRefundedCents }) {
  await ensurePartnerTables();
  let credit = invoiceId ? await creditEntryForInvoice(invoiceId) : null;
  if (!credit && chargeId) {
    const rows = await query(
      `SELECT * FROM partner_earnings WHERE kind = 'credit' AND stripe_charge_id = :charge
        ORDER BY id ASC LIMIT 1`,
      { charge: String(chargeId) }
    );
    credit = rows[0] || null;
  }
  if (!credit) return { reversed: false, reason: 'no_credit' };
  const total = Number(chargeAmountCents) || 0;
  const refunded = Number(amountRefundedCents) || 0;
  if (total <= 0 || refunded <= 0) return { reversed: false, reason: 'no_amount' };
  const already = await reversedCentsFor(credit.id);
  const target = Math.min(
    Number(credit.amount_cents),
    Math.round((Number(credit.amount_cents) * Math.min(refunded, total)) / total)
  );
  const due = target - already;
  if (due <= 0) return { reversed: false, reason: 'already_reversed' };
  return insertReversal({
    credit,
    key: refundId ? `rev:refund:${refundId}` : `rev:refund:${credit.id}:${target}`,
    amountCents: due,
    note: 'refund',
  });
}

/** Reverse the full remaining commission for a disputed charge. */
async function reverseForDispute({ disputeId, chargeId, invoiceId }) {
  await ensurePartnerTables();
  let credit = invoiceId ? await creditEntryForInvoice(invoiceId) : null;
  if (!credit && chargeId) {
    const rows = await query(
      `SELECT * FROM partner_earnings WHERE kind = 'credit' AND stripe_charge_id = :charge
        ORDER BY id ASC LIMIT 1`,
      { charge: String(chargeId) }
    );
    credit = rows[0] || null;
  }
  if (!credit) return { reversed: false, reason: 'no_credit' };
  const already = await reversedCentsFor(credit.id);
  const due = Number(credit.amount_cents) - already;
  if (due <= 0) return { reversed: false, reason: 'already_reversed' };
  return insertReversal({
    credit,
    key: disputeId ? `rev:disp:${disputeId}` : `rev:disp:${credit.id}`,
    amountCents: due,
    note: 'dispute',
  });
}

async function balanceCents(partnerUserId) {
  await ensurePartnerTables();
  const rows = await query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM partner_earnings
      WHERE partner_user_id = :uid`,
    { uid: Number(partnerUserId) }
  );
  return Number(rows[0] && rows[0].total) || 0;
}

/* ------------------------- payouts ------------------------- */

/**
 * Record a payout as PAID. The app records the payout only — the
 * money itself moves outside the app (Ely's manual/Stripe action).
 * Amount defaults to the full payable balance; must be > 0 and no
 * more than the balance.
 */
async function recordPayout({ partnerUserId, amountCents = null, method = '', note = '', paidBy }) {
  await ensurePartnerTables();
  const partner = Number(partnerUserId);
  const balance = await balanceCents(partner);
  const amount = amountCents != null ? Math.round(Number(amountCents)) : balance;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Payout amount must be positive.'), { code: 'VALIDATION', status: 400 });
  }
  if (amount > balance) {
    throw Object.assign(new Error('Payout exceeds the partner balance.'), { code: 'VALIDATION', status: 400 });
  }
  const r = await query(
    `INSERT INTO partner_payouts (partner_user_id, amount_cents, method, note, paid_by, created_at)
     VALUES (:partner, :amount, :method, :note, :by, :at)`,
    {
      partner,
      amount,
      method: String(method || '').slice(0, 64) || null,
      note: String(note || '').slice(0, 255) || null,
      by: paidBy != null ? Number(paidBy) : null,
      at: nowIso(),
    }
  );
  const payoutId = r.insertId;
  await query(
    `INSERT INTO partner_earnings
       (partner_user_id, kind, amount_cents, payout_id, note, created_at)
     VALUES (:partner, 'payout', :amount, :payout, :note, :at)`,
    { partner, amount: -amount, payout: payoutId, note: 'payout', at: nowIso() }
  );
  return { payoutId, amountCents: amount, balanceCents: balance - amount };
}

/* ------------------------- views ------------------------- */

function publicEntry(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    amountCents: Number(row.amount_cents) || 0,
    currency: row.currency || 'usd',
    stripeInvoiceId: row.stripe_invoice_id || null,
    note: row.note || null,
    createdAt: row.created_at || null,
  };
}

async function earningsSummary(partnerUserId) {
  await ensurePartnerTables();
  const uid = Number(partnerUserId);
  const [balance, rate, entries, payouts] = await Promise.all([
    balanceCents(uid),
    commissionRatePercent(),
    query(
      `SELECT * FROM partner_earnings WHERE partner_user_id = :uid ORDER BY id DESC LIMIT 200`,
      { uid }
    ),
    query(
      `SELECT * FROM partner_payouts WHERE partner_user_id = :uid ORDER BY id DESC LIMIT 100`,
      { uid }
    ),
  ]);
  return {
    partnerUserId: uid,
    balanceCents: balance,
    thresholdCents: PAYOUT_THRESHOLD_CENTS,
    eligible: balance >= PAYOUT_THRESHOLD_CENTS,
    ratePercent: rate,
    entries: entries.map(publicEntry),
    payouts: payouts.map((p) => ({
      id: Number(p.id),
      amountCents: Number(p.amount_cents) || 0,
      method: p.method || null,
      note: p.note || null,
      createdAt: p.created_at || null,
    })),
  };
}

async function listPartners() {
  await ensurePartnerTables();
  const users = await query(
    `SELECT id, email, name, status, created_at FROM users
      WHERE account_type = 'partner' ORDER BY id ASC`
  );
  const out = [];
  for (const u of users) {
    const summary = await earningsSummary(u.id);
    const workspaces = await workspacesOfUser(u.id);
    out.push({
      userId: Number(u.id),
      email: u.email,
      name: u.name || '',
      status: u.status || 'active',
      workspaceIds: workspaces,
      balanceCents: summary.balanceCents,
      eligible: summary.eligible,
      payoutCount: summary.payouts.length,
    });
  }
  return out;
}

/* ------------------------- purchase approvals ------------------------- */

async function createApprovalRequest({ workspaceId, requestedBy, actionKind, payload }) {
  await ensurePartnerTables();
  if (!ACTION_KINDS.includes(actionKind)) {
    throw Object.assign(new Error(`Unknown approval action: ${actionKind}`), {
      code: 'VALIDATION',
      status: 400,
    });
  }
  const r = await query(
    `INSERT INTO partner_approval_requests
       (workspace_id, requested_by, action_kind, payload_json, status, created_at)
     VALUES (:ws, :by, :kind, :payload, 'pending', :at)`,
    {
      ws: workspaceId != null ? Number(workspaceId) : null,
      by: Number(requestedBy),
      kind: actionKind,
      payload: JSON.stringify(payload || {}),
      at: nowIso(),
    }
  );
  return { id: r.insertId, status: 'pending', actionKind };
}

function publicApproval(row) {
  let payload = {};
  let result = null;
  try {
    payload = JSON.parse(row.payload_json || '{}') || {};
  } catch {
    payload = {};
  }
  try {
    result = row.result_json ? JSON.parse(row.result_json) : null;
  } catch {
    result = null;
  }
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id != null ? Number(row.workspace_id) : null,
    requestedBy: Number(row.requested_by),
    actionKind: row.action_kind,
    payload,
    status: row.status,
    decidedBy: row.decided_by != null ? Number(row.decided_by) : null,
    decidedAt: row.decided_at || null,
    result,
    createdAt: row.created_at || null,
  };
}

async function listApprovals({ status = null, requestedBy = null, limit = 100 } = {}) {
  await ensurePartnerTables();
  let sql = 'SELECT * FROM partner_approval_requests WHERE 1=1';
  const params = {};
  if (status) {
    sql += ' AND status = :status';
    params.status = String(status);
  }
  if (requestedBy != null) {
    sql += ' AND requested_by = :by';
    params.by = Number(requestedBy);
  }
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  sql += ` ORDER BY id DESC LIMIT ${lim}`;
  const rows = await query(sql, params);
  return rows.map(publicApproval);
}

async function getApproval(id) {
  await ensurePartnerTables();
  const rows = await query('SELECT * FROM partner_approval_requests WHERE id = :id LIMIT 1', {
    id: Number(id),
  });
  return rows[0] ? publicApproval(rows[0]) : null;
}

/** Execute an approved request's stored action (admin is the actor). */
async function executeApproval(approval, adminUserId) {
  const ws = approval.workspaceId;
  const p = approval.payload || {};
  switch (approval.actionKind) {
    case 'domain_register': {
      const domain = require('./domain');
      return domain.domainsRegister(ws, p);
    }
    case 'call_number_purchase': {
      const domain = require('./domain');
      return domain.adminPurchaseCallNumber(ws, p);
    }
    case 'credits_checkout': {
      const billing = require('./billing');
      return billing.createCreditsCheckoutSession(
        approval.requestedBy,
        p.workspaceId || ws,
        { quantity: p.quantity }
      );
    }
    case 'domain_flow_complete': {
      const domain = require('./domain');
      return domain.domainFlowComplete(ws, Number(p.txnId));
    }
    case 'hostinger_deploy': {
      const hostingerDeploy = require('./hostingerDeploy');
      return hostingerDeploy.startDeployment({
        workspaceId: ws,
        leadId: Number(p.leadId),
        actorUserId: Number(adminUserId),
        confirmText: p.confirmText,
        confirmPriceCents: p.confirmPriceCents,
        confirmFirstPeriodCents: p.confirmFirstPeriodCents,
      });
    }
    default:
      throw Object.assign(new Error(`No executor for action: ${approval.actionKind}`), {
        code: 'VALIDATION',
        status: 400,
      });
  }
}

async function decideApproval({ approvalId, adminUserId, approve }) {
  await ensurePartnerTables();
  const approval = await getApproval(approvalId);
  if (!approval) {
    throw Object.assign(new Error('Approval request not found.'), { code: 'NOT_FOUND', status: 404 });
  }
  if (approval.status !== 'pending') {
    throw Object.assign(new Error('That request was already decided.'), { code: 'CONFLICT', status: 409 });
  }
  if (!approve) {
    await query(
      `UPDATE partner_approval_requests
          SET status = 'denied', decided_by = :by, decided_at = :at
        WHERE id = :id`,
      { by: Number(adminUserId), at: nowIso(), id: approval.id }
    );
    return { ...approval, status: 'denied', decidedBy: Number(adminUserId) };
  }
  let result = null;
  let status = 'executed';
  try {
    result = await executeApproval(approval, adminUserId);
  } catch (e) {
    status = 'failed';
    result = { error: (e && e.code) || 'ERROR', message: (e && e.message) || String(e) };
  }
  await query(
    `UPDATE partner_approval_requests
        SET status = :status, decided_by = :by, decided_at = :at, result_json = :result
      WHERE id = :id`,
    {
      status,
      by: Number(adminUserId),
      at: nowIso(),
      result: JSON.stringify(result == null ? null : result).slice(0, 8000),
      id: approval.id,
    }
  );
  return { ...approval, status, decidedBy: Number(adminUserId), result };
}

/**
 * The purchase gate. When the acting user is a partner, the purchase
 * does NOT execute: an approval request is created and a result
 * object is returned for the route to answer with. Returns null when
 * the actor is not a partner (the route proceeds normally).
 */
async function gatePurchase({ userId, workspaceId, actionKind, payload }) {
  if (!userId) return null;
  if (!(await isPartnerUser(userId))) return null;
  const created = await createApprovalRequest({
    workspaceId,
    requestedBy: userId,
    actionKind,
    payload,
  });
  return {
    approvalRequired: true,
    approvalId: created.id,
    actionKind,
    message:
      'This purchase needs admin approval first. Your request was sent to the BitPype team — nothing was charged or started.',
  };
}

/**
 * Workspace-flavored gate for MCP tools (token callers carry no user):
 * a purchase tool called against a partner's workspace is treated as
 * partner-initiated and gated the same way, attributed to the
 * workspace's partner.
 */
async function gatePurchaseForWorkspace({ workspaceId, actionKind, payload }) {
  const partner = await partnerOfWorkspace(workspaceId);
  if (!partner) return null;
  const created = await createApprovalRequest({
    workspaceId,
    requestedBy: partner.id,
    actionKind,
    payload,
  });
  return {
    approvalRequired: true,
    approvalId: created.id,
    actionKind,
    message:
      'This purchase needs admin approval first. Your request was sent to the BitPype team — nothing was charged or started.',
  };
}

/* ------------------------- settings denial ------------------------- */

/**
 * Express middleware: deny partner sessions on settings writes with a
 * coded 403. Non-session callers (workspace tokens) pass through to
 * the route's own role gate, which already denies them.
 */
async function denyPartnerSettings(req, res, next) {
  try {
    const userId = (req.auth && req.auth.userId) || (req.session && req.session.userId) || null;
    if (userId && (await isPartnerUser(userId))) {
      return res.status(403).json({
        ok: false,
        error: 'PARTNER_SETTINGS_FORBIDDEN',
        code: 'PARTNER_SETTINGS_FORBIDDEN',
        message: 'Partner accounts cannot change settings. Ask the BitPype team if something needs updating.',
      });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

/* ------------------------- webhook attribution ------------------------- */

/** Subscription (recurring) portion of an invoice, in cents. */
function recurringBaseCents(invoice) {
  const lines = invoice && invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : null;
  if (!lines || !lines.length) return Math.max(0, Math.round(Number(invoice && invoice.amount_paid) || 0));
  let base = 0;
  let sawRecurring = false;
  for (const line of lines) {
    const amount = Math.round(Number(line && line.amount) || 0);
    const recurring = !!(line && line.price && line.price.recurring) || (line && line.type === 'subscription');
    if (recurring) {
      base += amount;
      sawRecurring = true;
    }
  }
  if (!sawRecurring) return Math.max(0, Math.round(Number(invoice.amount_paid) || 0));
  return Math.max(0, base);
}

/** Resolve the workspace a paid invoice belongs to (see header). */
async function attributeInvoiceWorkspace(invoice, payingUserId) {
  const subscriptionId = invoice && invoice.subscription ? String(invoice.subscription) : '';
  if (subscriptionId) {
    try {
      const workspaceDb = require('./workspaceDb');
      const rows = await query('SELECT id FROM workspaces ORDER BY id ASC');
      const ids = (rows || []).map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
      for (const wsId of ids) {
        let hit = null;
        try {
          const db = workspaceDb.openWorkspaceDb(wsId);
          const domainFlow = require('./domainFlow');
          domainFlow.ensureTables(db);
          hit = db
            .prepare(
              `SELECT id FROM domain_transactions
                WHERE stripe_subscription_id = ? AND billing_user_id IS NOT NULL
                ORDER BY id DESC LIMIT 1`
            )
            .get(subscriptionId);
        } catch {
          hit = null;
        }
        if (hit) return Number(wsId);
      }
    } catch {
      /* fall through to the membership fallback */
    }
  }
  if (payingUserId) {
    const memberships = await workspacesOfUser(payingUserId);
    const partnerWorkspaces = [];
    for (const wsId of memberships) {
      const partner = await partnerOfWorkspace(wsId);
      if (partner && Number(partner.id) !== Number(payingUserId)) partnerWorkspaces.push(wsId);
    }
    if (partnerWorkspaces.length === 1) return partnerWorkspaces[0];
  }
  return null;
}

/**
 * Webhook hook (invoice.paid, after the payment row is recorded):
 * attribute the payment and credit the workspace's partner. Never
 * throws — billing wraps the call, and a credit failure must not fail
 * the webhook.
 */
async function creditForInvoicePaid(invoice, { paymentId = null, payingUserId = null } = {}) {
  let payer = payingUserId;
  if (!payer && paymentId) {
    try {
      const rows = await query('SELECT user_id FROM payments WHERE id = :id LIMIT 1', {
        id: Number(paymentId),
      });
      payer = rows[0] ? rows[0].user_id : null;
    } catch {
      payer = null;
    }
  }
  const workspaceId = await attributeInvoiceWorkspace(invoice, payer);
  if (!workspaceId) return { credited: false, reason: 'no_workspace' };
  const partner = await partnerOfWorkspace(workspaceId);
  if (!partner) return { credited: false, reason: 'no_partner' };
  if (payer && Number(payer) === Number(partner.id)) {
    return { credited: false, reason: 'self_payment' };
  }
  return creditForPayment({
    partnerUserId: partner.id,
    workspaceId,
    invoiceId: invoice.id,
    chargeId: invoice.charge || null,
    paymentId,
    baseCents: recurringBaseCents(invoice),
    currency: invoice.currency || 'usd',
  });
}

module.exports = {
  DEFAULT_RATE_PERCENT,
  RATE_SETTING_KEY,
  PAYOUT_THRESHOLD_CENTS,
  ACTION_KINDS,
  ensurePartnerTables,
  getAccountType,
  isPartnerUser,
  partnerOfWorkspace,
  workspaceHasPartner,
  workspacesOfUser,
  commissionRatePercent,
  commissionFor,
  creditForPayment,
  reverseForRefund,
  reverseForDispute,
  balanceCents,
  recordPayout,
  earningsSummary,
  listPartners,
  createApprovalRequest,
  listApprovals,
  getApproval,
  decideApproval,
  gatePurchase,
  gatePurchaseForWorkspace,
  denyPartnerSettings,
  recurringBaseCents,
  attributeInvoiceWorkspace,
  creditForInvoicePaid,
};
