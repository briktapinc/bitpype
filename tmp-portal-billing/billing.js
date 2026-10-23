'use strict';

const { query, driver } = require('./db');
const platform = require('./platform');
const {
  PLAN_FREE,
  PLAN_STANDARD,
  PLAN_PREMIUM,
  normalizePlanId,
  getPlan,
  listPlans,
  isPaidPlan,
  maxPlan,
  publicPlan,
} = require('./plans');
const {
  getStripe,
  getPriceIdForPlan,
  getConfiguredPriceIds,
  planIdFromPriceId,
  getPublishableKey,
  appUrl,
  integrationId,
} = require('./stripeClient');

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

async function getUserBilling(userId) {
  const rows = await query(
    `SELECT id, email, name, status, is_super_admin,
            stripe_customer_id, stripe_subscription_id, subscription_status,
            subscription_price_id, billing_plan, current_period_end, deleted_at
     FROM users WHERE id = :id LIMIT 1`,
    { id: Number(userId) }
  );
  return rows[0] || null;
}

/** Active paid Stripe subscription (Standard or Premium). */
function isSubscribed(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return ACTIVE_STATUSES.has(String(user.subscription_status || ''));
}

function planOfUser(user) {
  if (!user) return PLAN_FREE;
  if (Number(user.is_super_admin) === 1) return PLAN_PREMIUM;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return PLAN_FREE;
  const stored = normalizePlanId(user.billing_plan);
  if (isSubscribed(user) && isPaidPlan(stored)) return stored;
  if (isSubscribed(user)) return PLAN_STANDARD; // legacy paid without mapped plan
  return PLAN_FREE;
}

/**
 * Core product access (website, edits, leads, etc.).
 * Free counts — Checkout is only required for Standard/Premium upgrades.
 * When billing.require_subscription is off, every active account has access.
 */
function hasProductAccess(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return true; // Free tier is the default for every active account
}

async function requireSubscriptionEnabled() {
  return (await platform.getPlatformSetting('billing.require_subscription', '1')) === '1';
}

async function workspaceOwnerRows(workspaceId) {
  if (!workspaceId) return [];
  return query(
    `SELECT u.id, u.is_super_admin, u.subscription_status, u.status, u.deleted_at,
            u.billing_plan, u.subscription_price_id
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = :workspaceId AND m.role IN ('owner','admin')`,
    { workspaceId: Number(workspaceId) }
  );
}

/** True if any owner/admin has an active paid plan. */
async function workspaceHasSubscription(workspaceId) {
  const members = await workspaceOwnerRows(workspaceId);
  return (members || []).some((u) => isSubscribed(u));
}

/** Highest plan among workspace owners/admins (Free if none paid). */
async function workspacePlan(workspaceId) {
  const members = await workspaceOwnerRows(workspaceId);
  let best = PLAN_FREE;
  for (const u of members || []) {
    best = maxPlan(best, planOfUser(u));
  }
  return best;
}

async function workspaceHasProductAccess(workspaceId) {
  if (!workspaceId) return false;
  const required = await requireSubscriptionEnabled();
  if (!required) return true;
  const members = await workspaceOwnerRows(workspaceId);
  return (members || []).some((u) => hasProductAccess(u));
}

async function ensureCustomer(user) {
  // Re-read — parallel checkouts may have filled stripe_customer_id already.
  const fresh = await getUserBilling(user.id);
  if (fresh && fresh.stripe_customer_id) return fresh.stripe_customer_id;

  const stripe = await getStripe();
  let existingId = null;

  try {
    const found = await stripe.customers.search({
      query: `metadata['user_id']:'${Number(user.id)}'`,
      limit: 1,
    });
    if (found.data && found.data[0]) existingId = found.data[0].id;
  } catch { /* Search API may be unavailable on some accounts */ }

  if (!existingId && user.email) {
    try {
      const listed = await stripe.customers.list({ email: user.email, limit: 10 });
      const match = (listed.data || []).find(
        (c) => c.metadata && String(c.metadata.user_id) === String(user.id)
      ) || (listed.data && listed.data[0]);
      if (match) existingId = match.id;
    } catch { /* ignore */ }
  }

  if (!existingId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { user_id: String(user.id) },
    });
    existingId = customer.id;
  }

  // Only win the write if still empty (another request may have stored a customer).
  await query(
    `UPDATE users SET stripe_customer_id = :cid
     WHERE id = :id AND (stripe_customer_id IS NULL OR stripe_customer_id = '')`,
    { cid: existingId, id: user.id }
  );
  const again = await getUserBilling(user.id);
  return (again && again.stripe_customer_id) || existingId;
}

/**
 * Start Checkout for Standard or Premium.
 * @param {number} userId
 * @param {string} [planId] standard|premium (default standard)
 * @param {{ successUrl?: string, cancelUrl?: string }} [opts]
 */
async function createCheckoutSession(userId, planId = PLAN_STANDARD, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  const plan = normalizePlanId(planId);
  if (!isPaidPlan(plan)) {
    throw Object.assign(new Error('Choose Standard or Premium to subscribe'), { code: 'INVALID_PLAN' });
  }
  const priceId = String(await getPriceIdForPlan(plan) || '').trim();
  if (!priceId) {
    throw Object.assign(
      new Error(`No Stripe price configured for ${plan} (stripe.price_id_${plan})`),
      { code: 'PRICE_NOT_CONFIGURED' }
    );
  }
  const stripe = await getStripe();
  const customerId = await ensureCustomer(user);
  const base = appUrl();
  const successUrl = opts.successUrl
    || `${base}/#/billing?checkout=success&plan=${encodeURIComponent(plan)}`;
  const cancelUrl = opts.cancelUrl || `${base}/#/billing?checkout=cancel`;
  const params = {
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(user.id),
    metadata: { user_id: String(user.id), plan },
    subscription_data: {
      metadata: { user_id: String(user.id), plan },
    },
    // Omit payment_method_types — dynamic payment methods from Dashboard
  };
  const trialDays = Math.max(0, Math.min(365, Number(await platform.getPlatformSetting('billing.trial_days', '0')) || 0));
  if (trialDays > 0) params.subscription_data.trial_period_days = trialDays;
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      ...params,
      integration_identifier: integrationId(`sub-${plan}`),
    });
  } catch (e) {
    if (String(e.message || '').includes('integration_identifier')) {
      session = await stripe.checkout.sessions.create(params);
    } else {
      throw e;
    }
  }
  return { url: session.url, sessionId: session.id, plan };
}

async function createPortalSession(userId) {
  const user = await getUserBilling(userId);
  if (!user || !user.stripe_customer_id) {
    throw Object.assign(new Error('No Stripe customer yet — subscribe first'), { code: 'NO_CUSTOMER' });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${appUrl()}/#/billing`,
  });
  return { url: session.url };
}

async function resolvePlanFromSubscription(subscription) {
  const priceId = subscription.items && subscription.items.data && subscription.items.data[0]
    ? subscription.items.data[0].price.id
    : null;
  let plan = await planIdFromPriceId(priceId);
  if (!plan && subscription.metadata && subscription.metadata.plan) {
    const meta = normalizePlanId(subscription.metadata.plan);
    if (isPaidPlan(meta)) plan = meta;
  }
  if (!ACTIVE_STATUSES.has(String(subscription.status || ''))) {
    return { plan: PLAN_FREE, priceId };
  }
  return { plan: plan || PLAN_STANDARD, priceId };
}

async function syncSubscription(subscription) {
  if (!subscription || !subscription.id) return;
  const userId = Number(
    (subscription.metadata && subscription.metadata.user_id) || 0
  );
  let uid = userId;
  if (!uid && subscription.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(subscription.customer) }
    );
    if (rows[0]) uid = rows[0].id;
  }
  if (!uid) return;

  const { plan, priceId } = await resolvePlanFromSubscription(subscription);
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const periodEndSql = periodEnd
    ? periodEnd.toISOString().slice(0, 19).replace('T', ' ')
    : null;

  const active = ACTIVE_STATUSES.has(String(subscription.status || ''));
  await query(
    `UPDATE users SET
       stripe_subscription_id = :subId,
       subscription_status = :status,
       subscription_price_id = :priceId,
       billing_plan = :plan,
       current_period_end = :periodEnd
     WHERE id = :id`,
    {
      subId: subscription.id,
      status: subscription.status || '',
      priceId: priceId || '',
      plan: active ? plan : PLAN_FREE,
      periodEnd: periodEndSql,
      id: uid,
    }
  );
}

async function recordPaymentFromInvoice(invoice) {
  if (!invoice || !invoice.id) return null;
  const existing = await query(
    'SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1',
    { iid: invoice.id }
  );
  if (existing[0]) return existing[0].id;

  let userId = null;
  if (invoice.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(invoice.customer) }
    );
    if (rows[0]) userId = rows[0].id;
  }
  if (!userId && invoice.subscription_details && invoice.subscription_details.metadata) {
    userId = Number(invoice.subscription_details.metadata.user_id) || null;
  }
  if (!userId && invoice.subscription) {
    const subId = typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription.id;
    const rows = await query(
      'SELECT id FROM users WHERE stripe_subscription_id = :sid LIMIT 1',
      { sid: subId }
    );
    if (rows[0]) userId = rows[0].id;
  }

  const amount = Number(invoice.amount_paid != null ? invoice.amount_paid : invoice.amount_due) || 0;
  const pi = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : (invoice.payment_intent && invoice.payment_intent.id) || null;
  const charge = typeof invoice.charge === 'string'
    ? invoice.charge
    : (invoice.charge && invoice.charge.id) || null;

  try {
    const result = await query(
      `INSERT INTO payments
        (user_id, stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id,
         amount_cents, currency, status, description)
       VALUES
        (:userId, :invoiceId, :pi, :charge, :amount, :currency, :status, :description)`,
      {
        userId,
        invoiceId: invoice.id,
        pi,
        charge,
        amount,
        currency: String(invoice.currency || 'usd').toLowerCase(),
        status: invoice.status === 'paid' ? 'succeeded' : (invoice.status || 'open'),
        description: invoice.description || `Invoice ${invoice.number || invoice.id}`,
      }
    );
    return result.insertId || null;
  } catch (e) {
    // Concurrent invoice.paid webhooks — unique stripe_invoice_id.
    if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
      const rows = await query(
        'SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1',
        { iid: invoice.id }
      );
      return rows[0] ? rows[0].id : null;
    }
    throw e;
  }
}

async function recordRefundFromCharge(charge, refund) {
  if (!refund || !refund.id) return null;
  const existing = await query(
    'SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1',
    { rid: refund.id }
  );
  if (existing[0]) return existing[0].id;

  let paymentId = null;
  let userId = null;
  if (charge && charge.id) {
    const pays = await query(
      'SELECT id, user_id FROM payments WHERE stripe_charge_id = :cid LIMIT 1',
      { cid: charge.id }
    );
    if (pays[0]) {
      paymentId = pays[0].id;
      userId = pays[0].user_id;
    }
  }
  if (!userId && charge && charge.customer) {
    const rows = await query(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(charge.customer) }
    );
    if (rows[0]) userId = rows[0].id;
  }

  let insertId = null;
  try {
    const result = await query(
      `INSERT INTO refunds
        (payment_id, user_id, stripe_refund_id, amount_cents, currency, status, reason)
       VALUES
        (:paymentId, :userId, :refundId, :amount, :currency, :status, :reason)`,
      {
        paymentId,
        userId,
        refundId: refund.id,
        amount: Number(refund.amount) || 0,
        currency: String((charge && charge.currency) || refund.currency || 'usd').toLowerCase(),
        status: refund.status || 'succeeded',
        reason: refund.reason || '',
      }
    );
    insertId = result.insertId || null;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
      const rows = await query(
        'SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1',
        { rid: refund.id }
      );
      return rows[0] ? rows[0].id : null;
    }
    throw e;
  }
  if (paymentId) {
    await query(
      "UPDATE payments SET status = 'refunded' WHERE id = :id AND status = 'succeeded'",
      { id: paymentId }
    );
  }
  return insertId;
}

async function markSubscriptionAtRisk(customerId, reason) {
  if (!customerId) return;
  const rows = await query(
    'SELECT id, stripe_subscription_id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
    { cid: String(customerId) }
  );
  if (!rows[0]) return;
  console.warn('[billing] risk event for customer', customerId, reason, 'user', rows[0].id);
  // Keep subscription status from Stripe webhooks; log for ops visibility.
}

async function handleWebhookEvent(event) {
  const type = event.type;
  const obj = event.data && event.data.object;

  if (type === 'checkout.session.completed' && obj) {
    if (obj.mode === 'subscription' && obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      const userRef = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const planMeta = (obj.metadata && obj.metadata.plan) || '';
      if (userRef && !sub.metadata.user_id) {
        const meta = { user_id: String(userRef) };
        if (planMeta) meta.plan = String(planMeta);
        await stripe.subscriptions.update(subId, { metadata: meta });
        sub.metadata = Object.assign({}, sub.metadata, meta);
      } else if (planMeta && !sub.metadata.plan) {
        await stripe.subscriptions.update(subId, {
          metadata: Object.assign({}, sub.metadata || {}, { plan: String(planMeta) }),
        });
        sub.metadata = Object.assign({}, sub.metadata, { plan: String(planMeta) });
      }
      await syncSubscription(sub);
    }
    return;
  }

  if (type.startsWith('customer.subscription.') && obj) {
    await syncSubscription(obj);
    return;
  }

  if (type === 'invoice.paid' && obj) {
    await recordPaymentFromInvoice(obj);
    if (obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
    }
    return;
  }

  if (type === 'invoice.payment_failed' && obj) {
    await recordPaymentFromInvoice(obj);
    if (obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
    }
    return;
  }

  if (type === 'charge.refunded' && obj) {
    const refunds = (obj.refunds && obj.refunds.data) || [];
    for (const r of refunds) await recordRefundFromCharge(obj, r);
    return;
  }

  if (type === 'charge.dispute.created' && obj) {
    await markSubscriptionAtRisk(obj.customer, 'dispute');
    return;
  }

  if (type === 'radar.early_fraud_warning.created' && obj) {
    const chargeId = typeof obj.charge === 'string' ? obj.charge : (obj.charge && obj.charge.id);
    if (chargeId) {
      try {
        const stripe = await getStripe();
        const charge = await stripe.charges.retrieve(chargeId);
        await markSubscriptionAtRisk(charge.customer, 'early_fraud_warning');
      } catch (e) {
        console.warn('[billing] early fraud lookup:', e.message);
      }
    }
  }
}

async function catalogForApi() {
  const prices = await getConfiguredPriceIds();
  const labelStd = await platform.getPlatformSetting('billing.amount_label_standard', 'Standard · monthly');
  const labelPrem = await platform.getPlatformSetting('billing.amount_label_premium', 'Premium · monthly');
  return listPlans().map((p) => {
    const extras = {};
    if (p.id === PLAN_STANDARD) {
      extras.priceLabel = labelStd;
      extras.priceConfigured = !!prices.standard;
      extras.checkout = true;
    } else if (p.id === PLAN_PREMIUM) {
      extras.priceLabel = labelPrem;
      extras.priceConfigured = !!prices.premium;
      extras.checkout = true;
    } else {
      extras.priceConfigured = true;
      extras.checkout = false;
    }
    return publicPlan(p.id, extras);
  });
}

async function billingSummary(userId) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const prices = await getConfiguredPriceIds();
  const amountLabel = await platform.getPlatformSetting('billing.amount_label', 'Bitpype plans');
  const requireSub = await requireSubscriptionEnabled();
  const planId = planOfUser(user);
  const plan = getPlan(planId);
  const payments = await query(
    `SELECT id, amount_cents, currency, status, description, stripe_invoice_id, created_at
     FROM payments WHERE user_id = :id ORDER BY id DESC LIMIT 25`,
    { id: userId }
  );
  const productAccess = hasProductAccess(user);
  return {
    email: user.email,
    name: user.name,
    isSuperAdmin: Number(user.is_super_admin) === 1,
    subscriptionStatus: user.subscription_status || 'none',
    subscribed: isSubscribed(user),
    productAccess,
    plan: planId,
    planName: plan.name,
    entitlements: { ...plan.entitlements },
    currentPeriodEnd: user.current_period_end,
    stripeCustomerId: user.stripe_customer_id || null,
    hasCustomer: !!user.stripe_customer_id,
    priceId: prices.standard || null,
    priceIds: prices,
    publishableKey: (await getPublishableKey()) || null,
    amountLabel,
    requireSubscription: requireSub,
    plans: await catalogForApi(),
    payments,
  };
}

async function listPayments({ limit = 100, q = '' } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (String(q || '').trim()) {
    const like = `%${String(q).trim()}%`;
    return query(
      `SELECT p.*, u.email AS user_email
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE u.email LIKE :like OR p.stripe_invoice_id LIKE :like OR p.stripe_charge_id LIKE :like
       ORDER BY p.id DESC LIMIT ${lim}`,
      { like }
    );
  }
  return query(
    `SELECT p.*, u.email AS user_email
     FROM payments p
     LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.id DESC LIMIT ${lim}`
  );
}

async function listRefunds({ limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  return query(
    `SELECT r.*, u.email AS user_email, p.stripe_invoice_id
     FROM refunds r
     LEFT JOIN users u ON u.id = r.user_id
     LEFT JOIN payments p ON p.id = r.payment_id
     ORDER BY r.id DESC LIMIT ${lim}`
  );
}

async function adminRefundPayment(paymentId, { amountCents, reason } = {}) {
  const rows = await query('SELECT * FROM payments WHERE id = :id LIMIT 1', { id: Number(paymentId) });
  const payment = rows[0];
  if (!payment) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (!payment.stripe_charge_id && !payment.stripe_payment_intent_id) {
    throw Object.assign(new Error('Payment has no Stripe charge/PI to refund'), { code: 'NO_CHARGE' });
  }
  const stripe = await getStripe();
  const params = {
    reason: reason === 'fraudulent' || reason === 'duplicate' ? reason : 'requested_by_customer',
  };
  if (amountCents != null && Number(amountCents) > 0) params.amount = Number(amountCents);

  let refund;
  if (payment.stripe_charge_id) {
    params.charge = payment.stripe_charge_id;
    refund = await stripe.refunds.create(params);
  } else {
    params.payment_intent = payment.stripe_payment_intent_id;
    refund = await stripe.refunds.create(params);
  }

  const charge = payment.stripe_charge_id
    ? await stripe.charges.retrieve(payment.stripe_charge_id)
    : { id: null, currency: payment.currency, customer: null, refunds: { data: [refund] } };

  await recordRefundFromCharge(
    Object.assign(charge, { id: payment.stripe_charge_id || charge.id, currency: payment.currency }),
    refund
  );
  return { refundId: refund.id, status: refund.status, amount: refund.amount };
}

async function deleteAccount(userId, { immediate = true } = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (Number(user.is_super_admin) === 1) {
    const admins = await query('SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1 AND (status = \'active\' OR status IS NULL)');
    if (Number(admins[0].c) <= 1) {
      throw Object.assign(new Error('Cannot delete the last super admin'), { code: 'LAST_SUPER_ADMIN' });
    }
  }

  if (user.stripe_subscription_id) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(user.stripe_subscription_id, {
        invoice_now: false,
        prorate: !!immediate,
      });
    } catch (e) {
      console.warn('[billing.deleteAccount] cancel sub:', e.message);
    }
  }

  const tombstone = `deleted+${user.id}@deleted.local`;
  await query(
    `UPDATE users SET
       status = 'disabled',
       email = :email,
       name = 'Deleted user',
       password_hash = :hash,
       deleted_at = ${driver() === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP'},
       subscription_status = 'canceled',
       billing_plan = 'free',
       stripe_subscription_id = NULL
     WHERE id = :id`,
    {
      email: tombstone,
      hash: '!', // unusable hash
      id: user.id,
    }
  );

  await query('DELETE FROM workspace_members WHERE user_id = :id', { id: user.id });
  return { deleted: true };
}

module.exports = {
  ACTIVE_STATUSES,
  getUserBilling,
  isSubscribed,
  planOfUser,
  hasProductAccess,
  requireSubscriptionEnabled,
  workspaceHasSubscription,
  workspaceHasProductAccess,
  workspacePlan,
  ensureCustomer,
  createCheckoutSession,
  createPortalSession,
  syncSubscription,
  handleWebhookEvent,
  billingSummary,
  catalogForApi,
  listPayments,
  listRefunds,
  adminRefundPayment,
  deleteAccount,
  recordPaymentFromInvoice,
};
