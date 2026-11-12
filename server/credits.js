'use strict';

/**
 * Workspace credit wallet — buy packs via Stripe Checkout (mode=payment),
 * spend on social image + content generation.
 */

const { query, withConnection, driver } = require('./db');
const platform = require('./platform');

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function packConfig() {
  const priceId = String(
    process.env.STRIPE_PRICE_ID_CREDITS || (await platform.getPlatformSetting('stripe.price_id_credits', '')) || ''
  ).trim();
  const packAmount = Math.max(
    1,
    Math.floor(Number(await platform.getPlatformSetting('credits.pack_amount', '50')) || 50)
  );
  const packLabel =
    String((await platform.getPlatformSetting('credits.pack_label', '')) || '').trim() || `${packAmount} credits`;
  const perImage = Math.max(
    0,
    Math.floor(Number(await platform.getPlatformSetting('credits.per_social_image', '1')) || 0)
  );
  const perContent = Math.max(
    0,
    Math.floor(Number(await platform.getPlatformSetting('credits.per_social_content', '1')) || 0)
  );
  return {
    priceId,
    packAmount,
    packLabel,
    perImage,
    perContent,
    configured: !!priceId,
  };
}

async function getBalance(workspaceId) {
  const wid = Number(workspaceId);
  if (!Number.isFinite(wid) || wid < 1) return 0;
  const rows = await query('SELECT balance FROM credit_balances WHERE workspace_id = :wid LIMIT 1', { wid });
  return rows[0] ? Math.max(0, Number(rows[0].balance) || 0) : 0;
}

async function listLedger(workspaceId, { limit = 40 } = {}) {
  const wid = Number(workspaceId);
  const lim = Math.min(200, Math.max(1, Number(limit) || 40));
  if (!Number.isFinite(wid) || wid < 1) return [];
  return query(
    `SELECT id, workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id,
            stripe_checkout_session_id, created_at
     FROM credit_ledger
     WHERE workspace_id = :wid
     ORDER BY id DESC
     LIMIT ${lim}`,
    { wid }
  );
}

function spendIdempotencyKey(reason, refType, refId) {
  if (!refType || refId == null || refId === '') return null;
  return `spend:${String(reason || '').slice(0, 40)}:${String(refType).slice(0, 40)}:${String(refId).slice(0, 60)}`;
}

/**
 * Atomically apply a credit delta. Positive = grant, negative = spend.
 * Idempotent when stripeCheckoutSessionId / idempotencyKey is set (unique in ledger).
 */
async function applyDelta(
  workspaceId,
  delta,
  {
    userId = null,
    reason = '',
    refType = null,
    refId = null,
    stripeCheckoutSessionId = null,
    idempotencyKey = null,
  } = {}
) {
  const wid = Number(workspaceId);
  const d = Math.trunc(Number(delta) || 0);
  if (!Number.isFinite(wid) || wid < 1) throw fail('INVALID_WORKSPACE', 'workspaceId is required');
  if (!d) throw fail('INVALID_DELTA', 'Credit delta must be non-zero');

  const sessionKey = stripeCheckoutSessionId
    ? String(stripeCheckoutSessionId).trim()
    : idempotencyKey
      ? String(idempotencyKey).trim()
      : null;

  // Batch 145 (external review F04): idempotency is WORKSPACE-scoped.
  // The pre-check must only ever see this workspace's own rows — the
  // old global lookup returned another workspace's balance_after to
  // an unrelated customer whose derived key happened to collide.
  if (sessionKey) {
    const existing = await query(
      'SELECT id, balance_after FROM credit_ledger WHERE workspace_id = :wid AND stripe_checkout_session_id = :sid LIMIT 1',
      { wid, sid: sessionKey }
    );
    if (existing[0]) {
      return {
        balance: Number(existing[0].balance_after) || 0,
        ledgerId: existing[0].id,
        duplicate: true,
        idempotencyKey: sessionKey,
      };
    }
  }

  return withConnection(async (conn) => {
    if (driver() === 'sqlite') {
      // Batch 145 (external review F15): the depth-counted
      // beginTransaction() — the old raw conn.query('BEGIN
      // IMMEDIATE') bypassed the counter, so commit() no-opped and
      // the transaction stayed open (next op failed, exit rolled
      // the "successful" grant back).
      await conn.beginTransaction();
    } else {
      await conn.beginTransaction();
    }
    try {
      // Ensure a balance row exists so FOR UPDATE / concurrent grants cannot race on missing rows.
      if (driver() === 'sqlite') {
        await conn.execute(
          `INSERT INTO credit_balances (workspace_id, balance, updated_at)
           VALUES (?, 0, datetime('now'))
           ON CONFLICT(workspace_id) DO NOTHING`,
          [wid]
        );
      } else {
        await conn.execute(
          `INSERT IGNORE INTO credit_balances (workspace_id, balance, updated_at)
           VALUES (?, 0, CURRENT_TIMESTAMP)`,
          [wid]
        );
      }

      const lockSql =
        driver() === 'sqlite'
          ? 'SELECT balance FROM credit_balances WHERE workspace_id = ? LIMIT 1'
          : 'SELECT balance FROM credit_balances WHERE workspace_id = ? FOR UPDATE';
      const [balRows] = await conn.execute(lockSql, [wid]);
      let balance = balRows[0] ? Number(balRows[0].balance) || 0 : 0;

      const next = balance + d;
      if (next < 0) {
        throw fail(
          'INSUFFICIENT_CREDITS',
          `Not enough credits (need ${Math.abs(d)}, have ${balance}). Buy more credits in Billing.`,
          402
        );
      }

      if (driver() === 'sqlite') {
        await conn.execute(
          `UPDATE credit_balances SET balance = ?, updated_at = datetime('now') WHERE workspace_id = ?`,
          [next, wid]
        );
        const info = await conn.execute(
          `INSERT INTO credit_ledger
             (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [
            wid,
            userId != null ? Number(userId) : null,
            d,
            next,
            String(reason || '').slice(0, 120),
            refType ? String(refType).slice(0, 60) : null,
            refId != null ? String(refId).slice(0, 80) : null,
            sessionKey,
          ]
        );
        await conn.commit();
        return {
          balance: next,
          ledgerId: info[0] && info[0].insertId,
          duplicate: false,
          idempotencyKey: sessionKey,
        };
      }

      await conn.execute(
        `UPDATE credit_balances SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
        [next, wid]
      );
      const [result] = await conn.execute(
        `INSERT INTO credit_ledger
           (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          wid,
          userId != null ? Number(userId) : null,
          d,
          next,
          String(reason || '').slice(0, 120),
          refType ? String(refType).slice(0, 60) : null,
          refId != null ? String(refId).slice(0, 80) : null,
          sessionKey,
        ]
      );
      await conn.commit();
      return {
        balance: next,
        ledgerId: result.insertId,
        duplicate: false,
        idempotencyKey: sessionKey,
      };
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* */
      }
      if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
        if (sessionKey) {
          // Batch 145 (F04): workspace-scoped here too — a composite
          // (workspace_id, key) conflict is the only duplicate this
          // caller may legitimately observe.
          const existing = await query(
            'SELECT id, balance_after FROM credit_ledger WHERE workspace_id = :wid AND stripe_checkout_session_id = :sid LIMIT 1',
            { wid, sid: sessionKey }
          );
          if (existing[0]) {
            return {
              balance: Number(existing[0].balance_after) || 0,
              ledgerId: existing[0].id,
              duplicate: true,
              idempotencyKey: sessionKey,
            };
          }
        }
      }
      throw e;
    }
  });
}

async function grant(workspaceId, amount, meta = {}) {
  const n = Math.floor(Number(amount) || 0);
  if (n < 1) throw fail('INVALID_AMOUNT', 'Grant amount must be at least 1');
  return applyDelta(workspaceId, n, meta);
}

async function spend(workspaceId, amount, meta = {}) {
  const n = Math.floor(Number(amount) || 0);
  if (n < 1) {
    return { balance: await getBalance(workspaceId), ledgerId: null, skipped: true };
  }
  // Block new credit spend when the acting user is past_due (upgrades/purchases already gated).
  if (meta.userId != null) {
    try {
      const billing = require('./billing');
      const user = await billing.getUserBilling(meta.userId);
      billing.assertNotPastDue(user);
    } catch (e) {
      if (e && e.code === 'PAST_DUE') throw e;
      // ignore lookup failures — balance check still applies
    }
  }
  const idem = meta.idempotencyKey || spendIdempotencyKey(meta.reason, meta.refType, meta.refId);
  return applyDelta(workspaceId, -n, { ...meta, idempotencyKey: idem });
}

function creditsFromSession(session, packAmount) {
  const meta = session.metadata || {};
  const metaCredits = Math.floor(Number(meta.credits || 0) || 0);
  let qty = Math.floor(Number(meta.quantity || 0) || 0);
  if (!qty && session.line_items && session.line_items.data && session.line_items.data[0]) {
    qty = Math.floor(Number(session.line_items.data[0].quantity) || 0);
  }
  if (qty < 1) qty = 1;
  /* Batch 168 (external review F12): fulfill what was PURCHASED.
   * The checkout wrote the pack size into the session metadata at
   * purchase time; the previous code checked that field for
   * presence but recomputed from the CURRENT admin pack config —
   * changing the config between checkout and a webhook retry
   * granted the wrong number of credits for an already-priced
   * purchase. The snapshot wins; the live config is only a
   * fallback for sessions that predate the snapshot fields, and
   * an explicit metadata credit total wins when no pack math was
   * recorded at all. */
  const snapshotPack = Math.floor(Number(meta.pack_amount || 0) || 0);
  const pack = snapshotPack > 0 ? snapshotPack : Math.max(1, Math.floor(Number(packAmount) || 0) || 1);
  const recomputed = pack * qty;
  if (snapshotPack > 0 || meta.quantity != null) return recomputed;
  return metaCredits > 0 ? metaCredits : recomputed;
}

async function grantFromCheckoutSession(session) {
  if (!session || !session.id) return null;
  const meta = session.metadata || {};
  if (String(meta.purpose || '') !== 'credits') return null;

  const workspaceId = Number(meta.workspace_id || 0);
  const userId = Number(meta.user_id || session.client_reference_id || 0) || null;
  const cfg = await packConfig();
  const creditCount = creditsFromSession(session, cfg.packAmount);
  if (!workspaceId || creditCount < 1) {
    console.warn('[credits] checkout session missing workspace/credits', session.id, meta);
    return null;
  }

  const paymentStatus = String(session.payment_status || '');
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    return null;
  }

  const result = await grant(workspaceId, creditCount, {
    userId,
    reason: 'stripe_purchase',
    refType: 'checkout_session',
    refId: session.id,
    stripeCheckoutSessionId: session.id,
  });

  if (!result.duplicate) {
    try {
      const amountCents = Number(session.amount_total || 0) || 0;
      const currency = String(session.currency || 'usd').toLowerCase();
      const pi =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent && session.payment_intent.id) || null;
      await query(
        `INSERT INTO payments
           (user_id, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id,
            amount_cents, currency, status, description)
         VALUES
           (:userId, NULL, :pi, NULL, :amount, :currency, 'succeeded', :desc)`,
        {
          userId,
          pi,
          amount: amountCents,
          currency,
          desc: `Credits pack (+${creditCount}) for workspace #${workspaceId}`,
        }
      );
    } catch (e) {
      console.warn('[credits] payment ledger:', e.message);
    }
  }

  return result;
}

/**
 * Claw back credits granted for a checkout session (refund / dispute).
 * Idempotent via stripe_checkout_session_id = refund:{grantSession}:{refundId}.
 *
 * Batch 168 (external review F11): clawback is CUMULATIVE against
 * the refunded fraction of the original charge. The pre-fix code
 * deducted the FULL grant for every distinct refund id, so two
 * partial refunds removed the pack twice. Callers pass the charge's
 * cumulative amount_refunded + amount; the entitlement is
 * grant × refunded/charge, and only the increment above what was
 * already clawed for this grant is deducted. Without amounts the
 * historical full-refund default applies — still bounded by the
 * cumulative record, so a second call can never over-claw. When
 * the balance cannot cover the increment (credits already spent),
 * the shortfall is written to the ledger as a durable zero-delta
 * marker row for reconciliation instead of vanishing into a log
 * line (whether spent-credit debt is collected is Ely's policy
 * call — the record is what was missing).
 */
/* Batch 180 (M6): the cumulative math below is read-modify-write
 * (prior-clawed sum -> increment -> applyDelta). Two DISTINCT
 * partial-refund events for one charge carry distinct event ids,
 * so the platform event-claim does not serialize them, and both
 * in-flight calls used to read the same prior and over-claw (130%
 * of a grant in the concurrent repro). Serialize clawbacks per
 * grant (session id, falling back to payment intent) behind a
 * promise-chain mutex — the same in-process discipline as the
 * sqlite mutex in db.js — so the prior sum is always re-read
 * after the previous clawback for the grant has fully landed.
 * Sequential math is unchanged. */
const clawbackLocks = new Map();
async function withClawbackLock(key, fn) {
  const prior = clawbackLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => gate);
  clawbackLocks.set(key, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (clawbackLocks.get(key) === tail) clawbackLocks.delete(key);
  }
}

async function clawbackFromRefund(args = {}) {
  const key = args.checkoutSessionId
    ? `session:${String(args.checkoutSessionId)}`
    : args.paymentIntentId
      ? `pi:${String(args.paymentIntentId)}`
      : 'global';
  return withClawbackLock(key, () => clawbackFromRefundInner(args));
}

async function clawbackFromRefundInner({
  checkoutSessionId,
  refundId,
  paymentIntentId,
  cumulativeRefundedCents,
  chargeAmountCents,
} = {}) {
  let grantRow = null;
  const grantKey = checkoutSessionId ? String(checkoutSessionId).trim() : null;
  if (grantKey) {
    const rows = await query(
      `SELECT * FROM credit_ledger
       WHERE stripe_checkout_session_id = :sid AND delta > 0
       LIMIT 1`,
      { sid: grantKey }
    );
    grantRow = rows[0] || null;
  }
  if (!grantRow && paymentIntentId) {
    const pays = await query(
      `SELECT description FROM payments WHERE stripe_payment_intent_id = :pi ORDER BY id DESC LIMIT 1`,
      { pi: String(paymentIntentId) }
    );
    const desc = pays[0] && pays[0].description ? String(pays[0].description) : '';
    const m = desc.match(/workspace #(\d+)/i);
    const wid = m ? Number(m[1]) : 0;
    if (wid > 0) {
      const grantRows = await query(
        `SELECT * FROM credit_ledger
         WHERE reason = 'stripe_purchase' AND delta > 0 AND workspace_id = :wid
         ORDER BY id DESC LIMIT 5`,
        { wid }
      );
      grantRow = (grantRows || []).find((r) => r.stripe_checkout_session_id) || null;
    }
  }
  if (!grantRow) return { clawed: false, reason: 'no_grant' };

  const grant = Math.floor(Number(grantRow.delta) || 0);
  if (grant < 1) return { clawed: false, reason: 'zero' };
  const grantSession = String(grantRow.stripe_checkout_session_id || '');
  const rid = refundId ? String(refundId) : `clawback:${grantSession}`;
  // What has already been clawed for THIS grant (negative rows only;
  // the zero-delta shortfall markers below never count).
  const priorRows = await query(
    `SELECT COALESCE(SUM(-delta), 0) AS clawed FROM credit_ledger
     WHERE workspace_id = :wid AND reason = 'stripe_refund' AND delta < 0
       AND stripe_checkout_session_id LIKE :pat`,
    { wid: grantRow.workspace_id, pat: `refund:${grantSession}:%` }
  );
  const prior = Math.floor(Number(priorRows[0] && priorRows[0].clawed) || 0);
  let target = grant;
  const chargeAmt = Math.floor(Number(chargeAmountCents) || 0);
  const cumRef = Math.floor(Number(cumulativeRefundedCents) || 0);
  if (chargeAmt > 0 && cumRef > 0) {
    target = Math.floor((grant * Math.min(cumRef, chargeAmt)) / chargeAmt);
  }
  const increment = Math.max(0, Math.min(target, grant) - prior);
  if (increment < 1) return { clawed: false, reason: 'entitlement_already_clawed', prior };
  try {
    const result = await applyDelta(grantRow.workspace_id, -increment, {
      userId: grantRow.user_id,
      reason: 'stripe_refund',
      refType: 'refund',
      refId: rid,
      stripeCheckoutSessionId: `refund:${grantSession}:${rid}`,
    });
    return { clawed: !result.duplicate, ...result };
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT_CREDITS') {
      // Durable shortfall record (delta 0 — never counted as
      // clawed, never satisfies applyDelta's idempotency pre-check
      // for the real clawback key, so a later retry can still run).
      try {
        await query(
          `INSERT INTO credit_ledger
             (workspace_id, user_id, delta, balance_after, reason, ref_type, ref_id, stripe_checkout_session_id, created_at)
           VALUES (:wid, :uid, 0, 0, 'stripe_refund_shortfall', 'refund', :rid, :sid, ${driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP'})`,
          {
            wid: grantRow.workspace_id,
            uid: grantRow.user_id != null ? Number(grantRow.user_id) : null,
            rid,
            sid: `refund-shortfall:${rid}`,
          }
        );
      } catch (markerErr) {
        console.warn('[credits] shortfall marker failed:', markerErr.message);
      }
      console.warn(
        `[credits] refund clawback shortfall: workspace ${grantRow.workspace_id} grant ${grantSession} refund ${rid} wanted ${increment} — recorded for reconciliation`
      );
      return { clawed: false, reason: 'insufficient_balance_recorded', shortfall: increment };
    }
    throw e;
  }
}

async function freezeWorkspaceCredits(workspaceId, reason = 'risk_freeze') {
  const bal = await getBalance(workspaceId);
  if (bal < 1) return { frozen: 0, balance: bal };
  return applyDelta(workspaceId, -bal, {
    reason,
    refType: 'risk',
    refId: String(Date.now()),
    idempotencyKey: `freeze:${workspaceId}:${reason}:${Math.floor(Date.now() / 60000)}`,
  });
}

async function summaryForWorkspace(workspaceId) {
  const cfg = await packConfig();
  const balance = await getBalance(workspaceId);
  const recent = await listLedger(workspaceId, { limit: 15 });
  const usdPerCredit = Number(await platform.getPlatformSetting('credits.usd_per_credit', '1'));
  const packPriceUsd =
    Number.isFinite(usdPerCredit) && usdPerCredit > 0
      ? Math.round(cfg.packAmount * usdPerCredit * 100) / 100
      : null;
  return {
    balance,
    packAmount: cfg.packAmount,
    packLabel: cfg.packLabel,
    packPriceUsd,
    priceConfigured: cfg.configured,
    perSocialImage: cfg.perImage,
    perSocialContent: cfg.perContent,
    recent,
  };
}

module.exports = {
  packConfig,
  getBalance,
  listLedger,
  grant,
  spend,
  applyDelta,
  grantFromCheckoutSession,
  clawbackFromRefund,
  // Batch 168: exported for the regression suite (F12 snapshot pin).
  creditsFromSession,
  freezeWorkspaceCredits,
  summaryForWorkspace,
  spendIdempotencyKey,
};
