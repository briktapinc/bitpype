'use strict';

const { query, driver } = require('./db');
const platform = require('./platform');
const {
  PLAN_FREE,
  PLAN_STANDARD,
  PLAN_PRO,
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
  integrationId,
  appUrl,
} = require('./stripeClient');
const credits = require('./credits');
// Batch 154 (§9): deterministic Stripe idempotency keys (see
// server/stripeIdempotency.js) on every mutating Stripe call below.
const { stripeIdempotencyKey, stripeAttemptKey } = require('./stripeIdempotency');
const { invoiceSubscriptionId, invoiceSubscriptionMetadata } = require('./stripeShapes');
const { staffUrl } = require('./appUrls');

/** Includes past_due for grace access (banner + portal to update card). */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
/** Healthy paid — used for upgrades / “all clear” UI (excludes past_due). */
const HEALTHY_PAID_STATUSES = new Set(['active', 'trialing']);

async function getUserBilling(userId) {
  const rows = await query(
    `SELECT id, email, name, status, is_super_admin, account_type,
            stripe_customer_id, stripe_subscription_id, subscription_status,
            subscription_price_id, billing_plan, current_period_end, deleted_at
     FROM users WHERE id = :id LIMIT 1`,
    { id: Number(userId) }
  );
  return rows[0] || null;
}

/** Active paid Stripe subscription (Standard or Premium), including past_due grace. */
function isSubscribed(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return ACTIVE_STATUSES.has(String(user.subscription_status || ''));
}

function isHealthyPaid(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return HEALTHY_PAID_STATUSES.has(String(user.subscription_status || ''));
}

/** Block upgrades / credit purchases while subscription is past_due (use Billing Portal). */
function assertNotPastDue(user) {
  if (!user) return;
  if (Number(user.is_super_admin) === 1) return;
  if (String(user.subscription_status || '') === 'past_due') {
    throw Object.assign(
      new Error('Payment past due — update your card in Billing Portal before purchasing or upgrading'),
      { code: 'PAST_DUE', status: 402 }
    );
  }
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
 * Free tier always has core access — Checkout is only for Standard/Premium upgrades.
 * billing.require_subscription controls paid entitlements elsewhere, not this gate.
 */
function hasProductAccess(user) {
  if (!user) return false;
  if (Number(user.is_super_admin) === 1) return true;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return false;
  return true;
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

/**
 * Entitlement plan for an actor: max(workspace owner/admin plan, actor's own plan).
 * Portal clients pay as members — their subscription must unlock features.
 */
async function effectivePlan(workspaceId, opts = {}) {
  let best = await workspacePlan(workspaceId);
  let user = null;
  if (opts.userId != null && Number(opts.userId) > 0) {
    user = await getUserBilling(opts.userId);
  } else if (opts.email) {
    const email = String(opts.email || '')
      .trim()
      .toLowerCase();
    if (email) {
      const rows = await query(
        `SELECT id, email, name, status, is_super_admin,
                stripe_customer_id, stripe_subscription_id, subscription_status,
                subscription_price_id, billing_plan, current_period_end, deleted_at
         FROM users WHERE email = :email LIMIT 1`,
        { email }
      );
      user = rows[0] || null;
    }
  }
  if (user) best = maxPlan(best, planOfUser(user));
  return best;
}

const STRIPE_EVENT_CLAIM_TTL_MS = 15 * 60 * 1000;

function sqlDateTimeUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseStoredDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Claim Stripe event.id for idempotency. Returns false only when the
 * event is genuinely already handled: a COMPLETED claim, or a live
 * claim younger than the TTL. Batch 145 (external review F12): the
 * old insert-only claim wedged an event forever when the process
 * died between claim and dispatch — the row existed, so every
 * redelivery read "duplicate" and the transition was never applied.
 * A claim older than STRIPE_EVENT_CLAIM_TTL_MS with no completion
 * mark is crash residue: it is reclaimed (CAS on the old claim
 * stamp, so two concurrent redeliveries can't both win) and the
 * event is reprocessed.
 */
async function claimStripeEvent(event) {
  if (!event || !event.id) return true;
  const id = String(event.id);
  const type = String(event.type || '');
  const now = sqlDateTimeUtc(Date.now());
  try {
    await query(`INSERT INTO stripe_events (event_id, type, claimed_at) VALUES (:id, :type, :now)`, {
      id,
      type,
      now,
    });
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = e && (e.code || e.errno);
    if (
      !(
        code === 'ER_DUP_ENTRY' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT' ||
        /Duplicate entry|UNIQUE constraint/i.test(msg)
      )
    ) {
      throw e;
    }
  }
  let rows;
  try {
    rows = await query(
      'SELECT claimed_at, completed_at, processed_at FROM stripe_events WHERE event_id = :id LIMIT 1',
      { id }
    );
  } catch {
    return false;
  }
  const row = rows && rows[0];
  if (!row) return false;
  if (row.completed_at) return false;
  const claimedAt = parseStoredDateTime(row.claimed_at) || parseStoredDateTime(row.processed_at);
  if (!claimedAt) return false;
  if (Date.now() - claimedAt.getTime() < STRIPE_EVENT_CLAIM_TTL_MS) return false;
  // Stale, uncompleted claim — reclaim it. The WHERE pins the exact
  // claim stamp we read (COALESCE mirrors the fallback above), so a
  // racing reclaim or a completion landing in between makes this
  // update match nothing and the event stays a duplicate.
  try {
    const upd = await query(
      `UPDATE stripe_events
          SET claimed_at = :now, type = :type
        WHERE event_id = :id
          AND completed_at IS NULL
          AND COALESCE(claimed_at, processed_at) = :oldStamp`,
      { now, type, id, oldStamp: sqlDateTimeUtc(claimedAt.getTime()) }
    );
    return Number((upd && (upd.affectedRows ?? upd.changes)) || 0) > 0;
  } catch {
    return false;
  }
}

/** Mark a claimed event fully processed; completed claims are
 *  permanent duplicates (never reclaimed). */
async function markStripeEventComplete(eventId) {
  if (!eventId) return;
  try {
    await query('UPDATE stripe_events SET completed_at = :now WHERE event_id = :id', {
      now: sqlDateTimeUtc(Date.now()),
      id: String(eventId),
    });
  } catch (e) {
    console.warn('[billing] markStripeEventComplete:', e.message);
  }
}

async function releaseStripeEvent(eventId) {
  if (!eventId) return;
  try {
    await query('DELETE FROM stripe_events WHERE event_id = :id', { id: String(eventId) });
  } catch (e) {
    console.warn('[billing] releaseStripeEvent:', e.message);
  }
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
  } catch (e) {
    // Falling through creates a NEW Stripe customer — log it so a
    // duplicate-customer trail is visible (port of audit F-17).
    console.warn('[billing] customers.search failed; will try list/create:', e.message);
  }

  // Only reuse a Stripe customer when metadata.user_id matches — never bind by email alone.
  if (!existingId && user.email) {
    try {
      const listed = await stripe.customers.list({ email: user.email, limit: 10 });
      const match = (listed.data || []).find((c) => c.metadata && String(c.metadata.user_id) === String(user.id));
      if (match) existingId = match.id;
    } catch (e) {
      console.warn('[billing] customers.list failed; will create a new customer:', e.message);
    }
  }

  if (!existingId) {
    const customer = await stripe.customers.create(
      {
        email: user.email,
        name: user.name || undefined,
        metadata: { user_id: String(user.id) },
      },
      // Batch 154: one Stripe customer per user — a retried create
      // for the same user replays the original customer.
      { idempotencyKey: stripeIdempotencyKey('customer-create', user.id) }
    );
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
 * Start Checkout for a paid plan.
 * @param {number} userId
 * @param {string} [planId] standard|pro|premium (default standard)
 * @param {{ successUrl?: string, cancelUrl?: string, forceCheckout?: boolean, metadata?: any }} [opts]
 */
async function createCheckoutSession(userId, planId = PLAN_STANDARD, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  assertNotPastDue(user);
  const plan = normalizePlanId(planId);
  if (!isPaidPlan(plan)) {
    throw Object.assign(new Error('Choose Standard, Pro, or Premium to subscribe'), { code: 'INVALID_PLAN' });
  }
  if (isSubscribed(user) && user.stripe_subscription_id && !opts.forceCheckout) {
    throw Object.assign(new Error('You already have an active subscription — use change-plan to switch'), {
      code: 'ALREADY_SUBSCRIBED',
    });
  }
  const priceId = String((await getPriceIdForPlan(plan)) || '').trim();
  if (!priceId) {
    throw Object.assign(new Error(`No Stripe price configured for ${plan} (stripe.price_id_${plan})`), {
      code: 'PRICE_NOT_CONFIGURED',
    });
  }
  const stripe = await getStripe();
  // Never open a second Checkout while Stripe still reports an active subscription.
  if (opts.forceCheckout && user.stripe_subscription_id) {
    try {
      const existingSub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
      if (ACTIVE_STATUSES.has(String(existingSub.status || ''))) {
        throw Object.assign(new Error('Active subscription exists — use Billing Portal or change-plan'), {
          code: 'ALREADY_SUBSCRIBED',
        });
      }
    } catch (e) {
      if (e.code === 'ALREADY_SUBSCRIBED') throw e;
      // retrieve failed — safe to start a new checkout
    }
  }
  const customerId = await ensureCustomer(user);
  const successUrl = opts.successUrl || staffUrl('billing', { checkout: 'success', plan });
  const cancelUrl = opts.cancelUrl || staffUrl('billing', { checkout: 'cancel' });
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
  // Caller-defined metadata (e.g. the domain purchase flow carries its
  // transaction id here so the webhook can find it after payment).
  if (opts.metadata && typeof opts.metadata === 'object') {
    for (const [k, v] of Object.entries(opts.metadata)) {
      if (v != null && v !== '') {
        params.metadata[k] = String(v);
        params.subscription_data.metadata[k] = String(v);
      }
    }
  }
  const trialDays = Math.max(
    0,
    Math.min(365, Number(await platform.getPlatformSetting('billing.trial_days', '0')) || 0)
  );
  if (trialDays > 0) params.subscription_data.trial_period_days = trialDays;
  // Batch 154: deterministic key from the operation's business ids
  // (user + plan + price + caller metadata, e.g. a domain
  // transaction id) — the integration_identifier fallback retry
  // below is the SAME operation and reuses the SAME key.
  const checkoutKey = stripeAttemptKey(
    'checkout-subscription',
    user.id,
    plan,
    priceId,
    trialDays,
    JSON.stringify(params.metadata)
  );
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        ...params,
        integration_identifier: integrationId(`sub-${plan}`),
      },
      { idempotencyKey: checkoutKey }
    );
  } catch (e) {
    if (String(e.message || '').includes('integration_identifier')) {
      session = await stripe.checkout.sessions.create(params, { idempotencyKey: checkoutKey });
    } else {
      throw e;
    }
  }
  return { action: 'checkout', url: session.url, sessionId: session.id, plan };
}

async function createPortalSession(userId) {
  const user = await getUserBilling(userId);
  if (!user || !user.stripe_customer_id) {
    throw Object.assign(new Error('No Stripe customer yet — subscribe first'), { code: 'NO_CUSTOMER' });
  }
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: user.stripe_customer_id,
      return_url: staffUrl('billing'),
    },
    // Batch 180 (L5): "Manage billing" is a REPEATABLE action —
    // the deterministic Batch 154 key replayed the first session
    // for 24h (a possibly-dead portal door). Per-attempt key, like
    // the other F06 fixes.
    { idempotencyKey: stripeAttemptKey('billing-portal', user.stripe_customer_id, 'staff-billing') }
  );
  return { url: session.url };
}

/**
 * Fetch live Stripe subscription flags (cancel_at_period_end, item price).
 * Returns null when the user has no subscription id.
 */
async function getLiveSubscription(user) {
  if (!user || !user.stripe_subscription_id) return null;
  try {
    const stripe = await getStripe();
    return await stripe.subscriptions.retrieve(user.stripe_subscription_id);
  } catch (e) {
    console.warn('[billing] retrieve subscription:', e.message);
    return null;
  }
}

/**
 * Cancel at period end (downgrade to Free after current period).
 * Access stays paid until current_period_end and the website stays LIVE
 * for the whole paid period; only when Stripe concludes the subscription
 * (customer.subscription.deleted) does the plan clear and the site come
 * offline (see disableSitesForEndedSubscription).
 */
async function scheduleCancelAtPeriodEnd(userId) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    throw Object.assign(new Error('No active subscription to cancel'), { code: 'NO_SUBSCRIPTION' });
  }
  const stripe = await getStripe();
  const updated = await stripe.subscriptions.update(
    user.stripe_subscription_id,
    {
      cancel_at_period_end: true,
    },
    // Batch 154: keyed by subscription + the exact change.
    {
      idempotencyKey: stripeAttemptKey(
        'subscription-update',
        user.stripe_subscription_id,
        'cancel_at_period_end=true'
      ),
    }
  );
  await syncSubscription(updated);
  // Batch 63: cancel confirmation email (deduped per subscription +
  // period inside lifecycleComms — the customer.subscription.updated
  // webhook echo of this same change lands on the same claim).
  // Best-effort: a mail failure never fails the cancel.
  try {
    await require('./lifecycleComms').sendCancelConfirmation(updated, {});
  } catch (e) {
    console.warn('[billing] cancel confirmation email:', e.message);
  }
  const periodEnd = updated.current_period_end
    ? new Date(updated.current_period_end * 1000).toISOString()
    : user.current_period_end || null;
  const endLabel = periodEnd ? formatDateLong(periodEnd) : null;
  return {
    action: 'cancel_at_period_end',
    plan: planOfUser(await getUserBilling(userId)),
    cancelAtPeriodEnd: true,
    currentPeriodEnd: periodEnd,
    message: endLabel
      ? `Your plan stays active until ${endLabel} — and your website stays live until then. After that date your plan moves to Free and your website comes offline.`
      : 'Your plan stays active until the end of the billing period — and your website stays live until then. After that your plan moves to Free and your website comes offline.',
  };
}

/**
 * Clear a scheduled cancel (keep current paid plan).
 */
async function resumeSubscription(userId) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    throw Object.assign(new Error('No active subscription to resume'), { code: 'NO_SUBSCRIPTION' });
  }
  const stripe = await getStripe();
  const updated = await stripe.subscriptions.update(
    user.stripe_subscription_id,
    {
      cancel_at_period_end: false,
    },
    {
      idempotencyKey: stripeAttemptKey(
        'subscription-update',
        user.stripe_subscription_id,
        'cancel_at_period_end=false'
      ),
    }
  );
  await syncSubscription(updated);
  // Batch 63: if the user cancels again later in the same period, the
  // confirmation + T-3 reminder must fire again — clear their claims.
  try {
    await require('./lifecycleComms').clearCancelClaims(user.stripe_subscription_id, {});
  } catch (e) {
    console.warn('[billing] cancel claims clear:', e.message);
  }
  return {
    action: 'resumed',
    plan: planOfUser(await getUserBilling(userId)),
    cancelAtPeriodEnd: false,
    message: 'Cancellation withdrawn — your plan will renew as usual.',
  };
}

/**
 * Switch Standard ↔ Premium on an existing Stripe subscription (proration).
 * Falls back to Checkout when there is no active subscription.
 * planId=free schedules cancel at period end.
 */
async function changeSubscriptionPlan(userId, planId, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  // Reject unknown ids before normalizePlanId (which maps unknowns → free).
  const raw = String(planId || '')
    .trim()
    .toLowerCase();
  if (!raw || ![PLAN_FREE, PLAN_STANDARD, PLAN_PRO, PLAN_PREMIUM].includes(raw)) {
    throw Object.assign(new Error('Choose Free, Standard, Pro, or Premium'), { code: 'INVALID_PLAN' });
  }
  const plan = normalizePlanId(raw);

  if (plan === PLAN_FREE) {
    return scheduleCancelAtPeriodEnd(userId);
  }
  if (!isPaidPlan(plan)) {
    throw Object.assign(new Error('Choose Free, Standard, Pro, or Premium'), { code: 'INVALID_PLAN' });
  }
  // Upgrades / plan switches while past_due → Billing Portal for card update first.
  assertNotPastDue(user);

  const priceId = String((await getPriceIdForPlan(plan)) || '').trim();
  if (!priceId) {
    throw Object.assign(new Error(`No Stripe price configured for ${plan} (stripe.price_id_${plan})`), {
      code: 'PRICE_NOT_CONFIGURED',
    });
  }

  if (!isSubscribed(user) || !user.stripe_subscription_id) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  const stripe = await getStripe();
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
  } catch (e) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  if (!ACTIVE_STATUSES.has(String(sub.status || ''))) {
    const checkout = await createCheckoutSession(userId, plan, {
      ...opts,
      forceCheckout: true,
    });
    return { ...checkout, action: 'checkout' };
  }

  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) {
    throw Object.assign(new Error('Subscription has no line items to update'), { code: 'NO_SUBSCRIPTION_ITEM' });
  }

  const currentPrice = item.price && item.price.id;
  if (currentPrice === priceId) {
    if (sub.cancel_at_period_end) {
      const resumed = await stripe.subscriptions.update(
        sub.id,
        {
          cancel_at_period_end: false,
          metadata: Object.assign({}, sub.metadata || {}, {
            user_id: String(user.id),
            plan,
          }),
        },
        {
          idempotencyKey: stripeAttemptKey(
            'subscription-update',
            sub.id,
            'cancel_at_period_end=false',
            `plan=${plan}`
          ),
        }
      );
      await syncSubscription(resumed);
      return {
        action: 'resumed',
        plan,
        cancelAtPeriodEnd: false,
        message: 'You are already on this plan — renewal will continue.',
      };
    }
    return {
      action: 'unchanged',
      plan,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      message: 'You are already on this plan.',
    };
  }

  const updated = await stripe.subscriptions.update(
    sub.id,
    {
      items: [{ id: item.id, price: priceId }],
      // Prorate immediately so upgrades/downgrades settle on the next invoice.
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false,
      metadata: Object.assign({}, sub.metadata || {}, {
        user_id: String(user.id),
        plan,
      }),
    },
    // Batch 154: keyed by subscription + item + target price — a
    // later switch to a different price is a different operation.
    {
      idempotencyKey: stripeAttemptKey('subscription-plan-change', sub.id, item.id, priceId),
    }
  );
  await syncSubscription(updated);
  const fresh = await getUserBilling(userId);
  return {
    action: 'updated',
    plan: planOfUser(fresh) || plan,
    subscriptionId: updated.id,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: fresh && fresh.current_period_end,
    message:
      plan === PLAN_PREMIUM
        ? 'Upgraded to Premium. Proration appears on your next invoice.'
        : plan === PLAN_PRO
          ? 'Switched to Pro. Proration appears on your next invoice.'
          : 'Switched to Standard. Proration appears on your next invoice.',
  };
}

/**
 * Unified entry: Checkout for first subscribe, subscription update when already paid.
 */
async function startOrChangePlan(userId, planId, opts = {}) {
  return changeSubscriptionPlan(userId, planId, opts);
}

async function userBelongsToWorkspace(userId, workspaceId) {
  const rows = await query(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = :uid AND workspace_id = :wid LIMIT 1`,
    { uid: Number(userId), wid: Number(workspaceId) }
  );
  return !!rows[0];
}

async function resolveWorkspaceIdForUser(userId, preferredWorkspaceId) {
  const preferred = Number(preferredWorkspaceId || 0);
  if (preferred > 0 && (await userBelongsToWorkspace(userId, preferred))) return preferred;
  const rows = await query(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = :uid
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, workspace_id ASC
     LIMIT 1`,
    { uid: Number(userId) }
  );
  return rows[0] ? Number(rows[0].workspace_id) : null;
}

/**
 * One-time Stripe Checkout for a credits pack (mode=payment).
 * Credits are granted on checkout.session.completed / async_payment_succeeded.
 */
async function createCreditsCheckoutSession(userId, workspaceId, opts = {}) {
  const user = await getUserBilling(userId);
  if (!user) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (String(user.status) === 'disabled' || user.deleted_at) {
    throw Object.assign(new Error('ACCOUNT_DISABLED'), { code: 'ACCOUNT_DISABLED' });
  }
  assertNotPastDue(user);
  const wid = Number(workspaceId);
  if (!Number.isFinite(wid) || wid < 1) {
    throw Object.assign(new Error('workspaceId is required to buy credits'), { code: 'WORKSPACE_REQUIRED' });
  }
  if (!(await userBelongsToWorkspace(userId, wid))) {
    throw Object.assign(new Error('You are not a member of this workspace'), { code: 'FORBIDDEN', status: 403 });
  }

  const cfg = await credits.packConfig();
  if (!cfg.priceId) {
    throw Object.assign(new Error('No credits Price ID configured (stripe.price_id_credits)'), {
      code: 'PRICE_NOT_CONFIGURED',
    });
  }

  const quantity = Math.min(20, Math.max(1, Math.floor(Number(opts.quantity) || 1)));
  const totalCredits = cfg.packAmount * quantity;
  const stripe = await getStripe();
  const customerId = await ensureCustomer(user);
  const successUrl = opts.successUrl || staffUrl('billing', { checkout: 'credits_success' });
  const cancelUrl = opts.cancelUrl || staffUrl('billing', { checkout: 'cancel' });

  const params = {
    mode: 'payment',
    customer: customerId,
    line_items: [{ price: cfg.priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(user.id),
    metadata: {
      purpose: 'credits',
      user_id: String(user.id),
      workspace_id: String(wid),
      credits: String(totalCredits),
      pack_amount: String(cfg.packAmount),
      quantity: String(quantity),
    },
    payment_intent_data: {
      metadata: {
        purpose: 'credits',
        user_id: String(user.id),
        workspace_id: String(wid),
        credits: String(totalCredits),
      },
    },
  };

  // Batch 154: deterministic key from user + workspace + pack
  // contents; the fallback retry reuses the SAME key.
  const creditsKey = stripeAttemptKey('checkout-credits', user.id, wid, cfg.priceId, quantity, totalCredits);
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        ...params,
        integration_identifier: integrationId('credits-pack'),
      },
      { idempotencyKey: creditsKey }
    );
  } catch (e) {
    if (String(e.message || '').includes('integration_identifier')) {
      session = await stripe.checkout.sessions.create(params, { idempotencyKey: creditsKey });
    } else {
      throw e;
    }
  }
  return {
    url: session.url,
    sessionId: session.id,
    credits: totalCredits,
    packAmount: cfg.packAmount,
    quantity,
    packLabel: cfg.packLabel,
  };
}

async function resolvePlanFromSubscription(subscription) {
  const priceId =
    subscription.items && subscription.items.data && subscription.items.data[0]
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
  const userId = Number((subscription.metadata && subscription.metadata.user_id) || 0);
  let uid = userId;
  if (!uid && subscription.customer) {
    const rows = await query('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
      cid: String(subscription.customer),
    });
    if (rows[0]) uid = rows[0].id;
  }
  if (!uid) return;

  // Batch 143 (full review): terminal-state guard. Once the tracked
  // subscription has been stored 'canceled' (customer.subscription.
  // deleted is final at Stripe — that id can never bill again), a
  // stale out-of-order event for the SAME subscription id carrying a
  // live status must not resurrect the plan: the conditional UPDATE
  // below deliberately allows a write when the incoming id equals
  // the tracked id, which is exactly the stale event's shape. A
  // genuinely new subscription carries a NEW id and takes over
  // through the existing NOT IN (active…) clause, unaffected.
  const trackedRows = await query(
    'SELECT stripe_subscription_id, subscription_status, current_period_end FROM users WHERE id = :id LIMIT 1',
    { id: uid }
  );
  const tracked = trackedRows[0];
  if (
    tracked &&
    String(tracked.subscription_status || '') === 'canceled' &&
    String(tracked.stripe_subscription_id || '') === String(subscription.id) &&
    String(subscription.status || '') !== 'canceled'
  ) {
    console.warn(
      '[billing] stale subscription event ignored for user',
      uid,
      '— subscription',
      subscription.id,
      'is canceled; incoming status',
      subscription.status
    );
    return { stale: true };
  }

  const { plan, priceId } = await resolvePlanFromSubscription(subscription);
  // Batch 145 (external review F16): modern Stripe API versions
  // moved the period end off the subscription's top level onto its
  // items — extract top-level ?? items.data[0] (the membership
  // module's subscriptionPeriodEnd pattern). When BOTH are absent
  // the value is unknown: KEEP the stored period end rather than
  // writing null over a known one.
  const periodRaw =
    subscription.current_period_end ??
    (subscription.items && Array.isArray(subscription.items.data) && subscription.items.data[0]
      ? subscription.items.data[0].current_period_end
      : undefined);
  let periodEndSql;
  if (periodRaw) {
    periodEndSql = new Date(periodRaw * 1000).toISOString().slice(0, 19).replace('T', ' ');
  } else if (tracked && tracked.current_period_end) {
    const stored = tracked.current_period_end;
    periodEndSql =
      stored instanceof Date
        ? stored.toISOString().slice(0, 19).replace('T', ' ')
        : String(stored).slice(0, 19);
  } else {
    periodEndSql = null;
  }

  const active = ACTIVE_STATUSES.has(String(subscription.status || ''));
  // Duplicate-completion guard (review fix): two checkout sessions can
  // complete for one user (double submit, two tabs) and Stripe creates
  // a subscription for each. The write is a single conditional UPDATE —
  // atomic at the row — that lands only when no DIFFERENT live
  // subscription is tracked: the first completion owns the row, a
  // second completion for another subscription is a no-op (it stays
  // live at Stripe but never overwrites the tracked state or gets
  // referral-awarded here; staff can cancel it from the Stripe
  // dashboard). Once the tracked subscription leaves an active
  // status, a new subscription may take over normally.
  const write = await query(
    `UPDATE users SET
       stripe_subscription_id = :subId,
       subscription_status = :status,
       subscription_price_id = :priceId,
       billing_plan = :plan,
       current_period_end = :periodEnd
     WHERE id = :id
       AND (stripe_subscription_id IS NULL
            OR stripe_subscription_id = ''
            OR stripe_subscription_id = :subId
            OR subscription_status NOT IN ('active', 'trialing', 'past_due'))`,
    {
      subId: subscription.id,
      status: subscription.status || '',
      priceId: priceId || '',
      plan: active ? plan : PLAN_FREE,
      periodEnd: periodEndSql,
      id: uid,
    }
  );
  if (write && write.affectedRows === 0) {
    console.warn(
      '[billing] duplicate subscription completion ignored for user',
      uid,
      '— incoming',
      subscription.id,
      'not applied over the tracked live subscription'
    );
    return { duplicate: true };
  }

  // Referral rewards: when a referred client activates a paid plan, credit the referrer.
  if (active && isPaidPlan(plan)) {
    try {
      const referrals = require('./referrals');
      await referrals.tryAwardForPaidUser(uid, {
        plan,
        subscription,
      });
    } catch (e) {
      console.warn('[billing] referral award:', e.message);
    }
  }
}

/** "$99.00" for USD; "99.00 EUR" otherwise. Cents in, display string out. */
function formatMoney(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  const cur = String(currency || 'usd').toLowerCase();
  return cur === 'usd' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${cur.toUpperCase()}`;
}

/** "November 27, 2026" from unix seconds, an ISO string, or a Date. */
function formatDateLong(value) {
  if (value == null || value === '') return null;
  const d =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value * 1000)
        : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

/** The users-row id an invoice belongs to (customer → subscription metadata → tracked subscription). */
async function resolveUserIdFromInvoice(invoice, q = query) {
  if (!invoice) return null;
  if (invoice.customer) {
    const rows = await q('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
      cid: String(invoice.customer),
    });
    if (rows[0]) return rows[0].id;
  }
  // Batch 145 (external review F17): modern invoices carry the
  // subscription metadata under parent.subscription_details and the
  // subscription reference at parent.subscription_details.subscription
  // — resolve both through the shared shape helpers.
  const subMeta = invoiceSubscriptionMetadata(invoice);
  if (subMeta) {
    const uid = Number(subMeta.user_id) || null;
    if (uid) return uid;
  }
  const invoiceSubId = invoiceSubscriptionId(invoice);
  if (invoiceSubId) {
    const rows = await q('SELECT id FROM users WHERE stripe_subscription_id = :sid LIMIT 1', {
      sid: invoiceSubId,
    });
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/**
 * Record an invoice payment once (stripe_invoice_id is unique).
 * Returns { id, inserted } — inserted is true ONLY for the call that
 * actually wrote the row, so webhook consumers (the Batch 37 renewal
 * email) can ride the dedupe and never double-fire on redelivery.
 */
async function recordPaymentFromInvoice(invoice) {
  if (!invoice || !invoice.id) return { id: null, inserted: false };
  const existing = await query('SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1', { iid: invoice.id });
  if (existing[0]) return { id: existing[0].id, inserted: false };

  const userId = await resolveUserIdFromInvoice(invoice);

  const amount = Number(invoice.amount_paid != null ? invoice.amount_paid : invoice.amount_due) || 0;
  const pi =
    typeof invoice.payment_intent === 'string'
      ? invoice.payment_intent
      : (invoice.payment_intent && invoice.payment_intent.id) || null;
  const charge = typeof invoice.charge === 'string' ? invoice.charge : (invoice.charge && invoice.charge.id) || null;

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
        status: invoice.status === 'paid' ? 'succeeded' : invoice.status || 'open',
        description: invoice.description || `Invoice ${invoice.number || invoice.id}`,
      }
    );
    return { id: result.insertId || null, inserted: true };
  } catch (e) {
    // Concurrent invoice.paid webhooks — unique stripe_invoice_id.
    if (e.code === 'ER_DUP_ENTRY' || /unique|duplicate/i.test(String(e.message || ''))) {
      const rows = await query('SELECT id FROM payments WHERE stripe_invoice_id = :iid LIMIT 1', { iid: invoice.id });
      return { id: rows[0] ? rows[0].id : null, inserted: false };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Batch 37 — renewal email + site-offline at subscription end.        */
/*                                                                     */
/* Ely's spec (2026-10-27): email the client every month when their    */
/* subscription renews, with a way to cancel; cancelling keeps the     */
/* plan AND the website live until the end of the paid period — only   */
/* then does the site come offline.                                    */
/*                                                                     */
/* Scope: PLATFORM plan subscriptions only (this module). Site-        */
/* membership subscriptions run on site owners' own Stripe keys        */
/* (server/siteModules.js) and are a different subsystem — untouched.  */
/* ------------------------------------------------------------------ */

/**
 * Durable manage/cancel link for billing emails. The client portal's
 * billing panel is deep-linkable via ?panel= (portal.js treats it as a
 * deep-link seed for email links), and its "Manage billing" button POSTs
 * the client-authenticated /billing/portal route, which creates a fresh
 * Stripe billing-portal session on click — so this one stable URL never
 * expires the way a raw portal-session URL would.
 */
function billingManageUrl() {
  const raw = typeof appUrl === 'function' ? appUrl() : '';
  const base = String(raw || '').replace(/\/$/, '');
  return `${base}/portal?panel=billing`;
}

/**
 * Resolve the websites a billing user owns, across every workspace they
 * belong to. A user reaches a site two ways in this codebase:
 *  - their lead in the workspace carries their email (email↔lead is
 *    unique per workspace) and websites.lead_id points at it;
 *  - a domain-flow transaction in the workspace names them directly
 *    (domain_transactions.billing_user_id).
 * Workspace tenant DBs are SQLite files opened via workspaceDb.
 * Returns [{ workspaceId, leadId, site, domains: [domainName, …] }].
 */
async function resolveUserSites(user, deps = {}) {
  if (!user || !user.id) return [];
  const q = deps.query || query;
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));
  const email = String(user.email || '').trim().toLowerCase();
  const memberRows = await q('SELECT workspace_id FROM workspace_members WHERE user_id = :uid', {
    uid: Number(user.id),
  });
  const workspaceIds = [...new Set((memberRows || []).map((r) => Number(r.workspace_id)).filter(Boolean))];
  const out = [];
  for (const workspaceId of workspaceIds) {
    let db;
    try {
      db = openDb(workspaceId);
    } catch (e) {
      console.warn('[billing] resolveUserSites openDb:', workspaceId, e.message);
      continue;
    }
    if (!db) continue;
    const leadIds = new Set();
    if (email) {
      try {
        for (const row of db
          .prepare('SELECT id FROM leads WHERE lower(email) = ?')
          .all(email)) leadIds.add(Number(row.id));
      } catch {
        /* leads table always exists in a workspace db; stay defensive */
      }
    }
    try {
      const hasTxn = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_transactions'")
        .get();
      if (hasTxn) {
        for (const row of db
          .prepare('SELECT DISTINCT lead_id FROM domain_transactions WHERE billing_user_id = ?')
          .all(Number(user.id))) {
          if (row.lead_id) leadIds.add(Number(row.lead_id));
        }
      }
    } catch {
      /* domain flow not installed in this workspace db */
    }
    for (const leadId of leadIds) {
      let sites = [];
      try {
        sites = db.prepare('SELECT * FROM websites WHERE lead_id = ?').all(leadId);
      } catch {
        sites = [];
      }
      for (const site of sites) {
        let domains = [];
        try {
          const hasDomains = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_domains'")
            .get();
          if (hasDomains) {
            domains = db
              .prepare("SELECT domain_name FROM site_domains WHERE website_id = ? AND status = 'linked'")
              .all(site.id)
              .map((r) => r.domain_name)
              .filter(Boolean);
          }
        } catch {
          domains = [];
        }
        out.push({ workspaceId, leadId, site, domains });
      }
    }
  }
  return out;
}

/**
 * Batch 37 — monthly renewal email. Fired from the invoice.paid webhook
 * branch ONLY when the caller actually inserted a new payment row
 * (recordPaymentFromInvoice's dedupe), so Stripe redeliveries can never
 * double-send. Only subscription CYCLE renewals qualify: the first
 * payment (billing_reason 'subscription_create') already gets Batch
 * 36's payment-received email / the signup flows. Best-effort by
 * contract — the caller wraps this so a mail failure never fails the
 * webhook; the return value reports what happened.
 */
async function sendRenewalEmailForInvoice(invoice, opts = {}) {
  const deps = opts.deps || {};
  if (!invoice || String(invoice.billing_reason || '') !== 'subscription_cycle') {
    return { sent: false, reason: 'not_a_cycle_renewal' };
  }
  const amountPaid = Number(invoice.amount_paid != null ? invoice.amount_paid : 0) || 0;
  if (!(amountPaid > 0)) return { sent: false, reason: 'no_amount_paid' };

  let user = opts.user || null;
  if (!user) {
    const uid = await resolveUserIdFromInvoice(invoice, deps.query || query);
    if (uid) user = await getUserBilling(uid);
  }
  if (!user || !user.email) return { sent: false, reason: 'no_billing_user' };
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
    return { sent: false, reason: 'user_disabled' };
  }

  const subscription = opts.subscription || null;
  let planId = null;
  if (subscription) {
    try {
      planId = (await resolvePlanFromSubscription(subscription)).plan;
    } catch {
      planId = null;
    }
  }
  if (!planId || !isPaidPlan(planId)) planId = planOfUser(user);
  const planName = (getPlan(planId) && getPlan(planId).name) || 'Bitpype';

  // The cycle invoice's period_end IS the next renewal date for a
  // monthly plan; the live subscription's current_period_end agrees.
  const linePeriod =
    invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].period
      ? invoice.lines.data[0].period.end
      : null;
  const periodEndSec =
    (subscription && subscription.current_period_end) || invoice.period_end || linePeriod || null;
  const nextRenewal = periodEndSec ? formatDateLong(periodEndSec) : null;
  const paidOn = invoice.created ? formatDateLong(invoice.created) : null;
  const amountLabel = formatMoney(amountPaid, invoice.currency);
  const manageUrl = billingManageUrl();

  let siteLine = null;
  try {
    const sites = await resolveUserSites(user, deps);
    const live = sites.find((s) => s.site && (s.site.custom_domain || (s.domains && s.domains.length)));
    const domain =
      (live && (live.site.custom_domain || live.domains[0])) ||
      (sites[0] && sites[0].site && sites[0].site.custom_domain) ||
      null;
    if (domain) siteLine = `Your website (${domain}) stays live while your plan is active.`;
  } catch (e) {
    console.warn('[billing] renewal email site lookup:', e.message);
  }

  const paragraphs = [
    `Good news — your ${planName} plan renewed${paidOn ? ` on ${paidOn}` : ''}. We charged ${amountLabel} to the card on file, and your plan is paid up${nextRenewal ? ` through ${nextRenewal}` : ' for the new period'}.`,
    ...(siteLine ? [siteLine] : []),
    nextRenewal
      ? `Your next renewal is ${nextRenewal}. You can update your card, switch plans, or cancel any time from your billing page — the button below opens it. If you cancel, nothing switches off straight away: your plan and your website stay live until ${nextRenewal}, the end of the period you've paid for.`
      : 'You can update your card, switch plans, or cancel any time from your billing page — the button below opens it. If you cancel, nothing switches off straight away: your plan and your website stay live until the end of the period you\'ve paid for.',
    'Questions about this charge? Just reply to this email.',
  ];
  const subject = `Your Bitpype ${planName} plan renewed — ${amountLabel}`;
  const sendMail = deps.sendMail || (async (mail) => require('./mailer').sendPlatformMail(mail));
  await sendMail({
    to: user.email,
    subject,
    title: subject,
    preheader: `${planName} renewed at ${amountLabel}${nextRenewal ? ` — paid through ${nextRenewal}` : ''}.`,
    paragraphs,
    text: paragraphs.join('\n\n'),
    cta: { url: manageUrl, label: 'Manage or cancel your plan' },
  });
  return { sent: true, to: user.email, subject, plan: planId, nextRenewal };
}

function ensureSubscriptionSiteDisableTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_site_disables (
    website_id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    subscription_id TEXT,
    prior_status TEXT,
    prior_custom_domain TEXT,
    reason TEXT NOT NULL DEFAULT 'subscription_ended',
    disabled_at TEXT DEFAULT (datetime('now'))
  )`);
}

/**
 * Batch 37 — take a subscription owner's website(s) offline when the
 * subscription has ENDED (customer.subscription.deleted — period-end
 * cancellation concluding, or dunning exhaustion). NOT a trigger for
 * scheduling a cancel: subscription.updated with cancel_at_period_end
 * never reaches this function, so the site stays live for the whole
 * paid period, exactly as the cancel copy promises.
 *
 * The disable primitive is Batch 27's soft archive (websites.archived_at
 * via websiteEngine.deleteWebsite — reversible with restoreWebsite; the
 * row, pages and data are untouched) PLUS unlinking any linked custom
 * domain (cfDomains.unlinkDomain detaches it from the Pages project, so
 * the public address stops serving; re-link restores it). A bookkeeping
 * row per site (subscription_site_disables) records prior state,
 * timestamp and reason 'subscription_ended', and makes replays no-ops.
 * Sites an admin already archived are left exactly as they are.
 */
async function disableSitesForEndedSubscription(subscription, deps = {}) {
  if (!subscription || !subscription.id) return { disabled: [], skipped: 'no_subscription' };
  let user = null;
  const metaUid = Number((subscription.metadata && subscription.metadata.user_id) || 0);
  if (metaUid) user = await getUserBilling(metaUid);
  if (!user && subscription.customer) {
    const rows = await (deps.query || query)(
      'SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1',
      { cid: String(subscription.customer) }
    );
    if (rows[0]) user = await getUserBilling(rows[0].id);
  }
  if (!user) return { disabled: [], skipped: 'no_user' };
  // Orphan/duplicate guard (the R6 lesson): if the user now tracks a
  // DIFFERENT live subscription, this deletion is not their live plan
  // ending — leave their sites alone.
  if (
    user.stripe_subscription_id &&
    String(user.stripe_subscription_id) !== String(subscription.id) &&
    ACTIVE_STATUSES.has(String(user.subscription_status || ''))
  ) {
    return { disabled: [], skipped: 'other_subscription_tracked', userId: user.id };
  }

  const archiveSite =
    deps.archiveSite || ((db, id) => require('../src/websiteEngine').deleteWebsite(db, id));
  const unlinkDomain =
    deps.unlinkDomain || (async (db, domain) => require('../src/cfDomains').unlinkDomain(db, { domain }));
  const openDb = deps.openDb || ((ws) => require('./workspaceDb').openWorkspaceDb(ws));

  const sites = await resolveUserSites(user, deps);
  const byWorkspace = new Map();
  for (const entry of sites) {
    if (!byWorkspace.has(entry.workspaceId)) byWorkspace.set(entry.workspaceId, []);
    byWorkspace.get(entry.workspaceId).push(entry);
  }

  const disabled = [];
  const skipped = [];
  for (const [workspaceId, entries] of byWorkspace) {
    let db;
    try {
      db = openDb(workspaceId);
    } catch (e) {
      console.warn('[billing] disable sites openDb:', workspaceId, e.message);
      continue;
    }
    if (!db) continue;
    ensureSubscriptionSiteDisableTables(db);
    for (const { site, domains } of entries) {
      const prior = db
        .prepare('SELECT website_id FROM subscription_site_disables WHERE website_id = ?')
        .get(site.id);
      if (prior) {
        skipped.push({ workspaceId, websiteId: site.id, reason: 'already_disabled' });
        continue;
      }
      if (site.archived_at) {
        skipped.push({ workspaceId, websiteId: site.id, reason: 'already_archived' });
        continue;
      }
      const linkedDomains = [...new Set([...(domains || []), site.custom_domain].filter(Boolean))];
      const isLive = String(site.status || '') === 'published' || linkedDomains.length > 0;
      if (!isLive) {
        skipped.push({ workspaceId, websiteId: site.id, reason: 'not_live' });
        continue;
      }
      db.prepare(
        `INSERT INTO subscription_site_disables
           (website_id, workspace_id, user_id, subscription_id, prior_status, prior_custom_domain, reason)
         VALUES (?, ?, ?, ?, ?, ?, 'subscription_ended')`
      ).run(
        site.id,
        workspaceId,
        Number(user.id),
        String(subscription.id),
        site.status || null,
        site.custom_domain || null
      );
      const unlinked = [];
      for (const domain of linkedDomains) {
        try {
          await unlinkDomain(db, domain);
          unlinked.push(domain);
        } catch (e) {
          console.warn('[billing] disable site unlink:', domain, e.message);
        }
      }
      const res = archiveSite(db, site.id);
      try {
        db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
          'billing',
          `Website #${site.id} taken offline (subscription_ended, user #${user.id}, sub ${subscription.id}); prior status ${site.status || 'unknown'}${unlinked.length ? `; unlinked ${unlinked.join(', ')}` : ''}.`
        );
      } catch {
        /* activity log is best-effort */
      }
      disabled.push({
        workspaceId,
        websiteId: site.id,
        priorStatus: site.status || null,
        unlinked,
        alreadyArchived: !!(res && res.alreadyArchived),
      });
    }
  }
  return { userId: user.id, disabled, skipped };
}

async function recordRefundFromCharge(charge, refund) {
  if (!refund || !refund.id) return null;
  const existing = await query('SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1', { rid: refund.id });
  if (existing[0]) return existing[0].id;
  // Batch 180 (M5): a charge stub with neither an id nor a payment
  // intent can never be linked to a payment — writing the refunds
  // row anyway leaves it unlinked AND makes the later REAL
  // charge.refunded webhook early-return on the duplicate refund
  // id, permanently losing the status update + credits clawback.
  // Skip the row; the real charge event will record it properly.
  if (!charge || (!charge.id && !charge.payment_intent)) {
    console.warn('[billing] refund not recorded — charge carries no id or payment intent', refund.id);
    return null;
  }

  let paymentId = null;
  let userId = null;
  let paymentRow = null;
  if (charge && charge.id) {
    const pays = await query(
      'SELECT id, user_id, amount_cents, stripe_payment_intent_id, description FROM payments WHERE stripe_charge_id = :cid LIMIT 1',
      { cid: charge.id }
    );
    if (pays[0]) {
      paymentId = pays[0].id;
      userId = pays[0].user_id;
      paymentRow = pays[0];
    }
  }
  if (!paymentRow && charge && charge.payment_intent) {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
    const pays = await query(
      'SELECT id, user_id, amount_cents, stripe_payment_intent_id, description FROM payments WHERE stripe_payment_intent_id = :pi LIMIT 1',
      { pi }
    );
    if (pays[0]) {
      paymentId = pays[0].id;
      userId = pays[0].user_id;
      paymentRow = pays[0];
    }
  }
  if (!userId && charge && charge.customer) {
    const rows = await query('SELECT id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
      cid: String(charge.customer),
    });
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
      const rows = await query('SELECT id FROM refunds WHERE stripe_refund_id = :rid LIMIT 1', { rid: refund.id });
      return rows[0] ? rows[0].id : null;
    }
    throw e;
  }
  if (paymentId && paymentRow) {
    /* Batch 168 (S4#3): compare the CHARGE's cumulative refunded
     * total, not this one refund's amount — a full refund delivered
     * as several partials (3000 then 7000 against 10000) previously
     * left the payment 'partially_refunded' forever, because each
     * event was judged on its own slice. The charge object carries
     * amount_refunded on both call paths (charge.refunded embeds it;
     * refund.created re-fetches the charge). Fall back to the single
     * refund's amount when the charge doesn't carry the field. The
     * shop pipeline (siteModules.js charge.refunded) already
     * compares this way. */
    const refundedCents =
      charge && charge.amount_refunded != null ? Number(charge.amount_refunded) || 0 : Number(refund.amount) || 0;
    const totalCents = Number(paymentRow.amount_cents) || 0;
    const status =
      totalCents > 0 && refundedCents > 0 && refundedCents < totalCents ? 'partially_refunded' : 'refunded';
    await query(
      "UPDATE payments SET status = :status WHERE id = :id AND status IN ('succeeded', 'partially_refunded')",
      { id: paymentId, status }
    );
  } else if (paymentId) {
    await query("UPDATE payments SET status = 'refunded' WHERE id = :id AND status = 'succeeded'", { id: paymentId });
  }

  // Claw back credits for credit-pack purchases.
  try {
    const desc = paymentRow && paymentRow.description ? String(paymentRow.description) : '';
    if (/credits pack/i.test(desc) || (paymentRow && paymentRow.stripe_payment_intent_id)) {
      let checkoutSessionId = null;
      try {
        const stripe = await getStripe();
        const pi =
          (paymentRow && paymentRow.stripe_payment_intent_id) ||
          (charge && charge.payment_intent
            ? typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : charge.payment_intent.id
            : null);
        if (pi) {
          const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
          if (sessions.data && sessions.data[0]) checkoutSessionId = sessions.data[0].id;
        }
      } catch {
        /* optional */
      }
      await credits.clawbackFromRefund({
        checkoutSessionId,
        refundId: refund.id,
        paymentIntentId: paymentRow && paymentRow.stripe_payment_intent_id,
        // Batch 168 (F11): cumulative entitlement inputs — the
        // charge object carries Stripe's cumulative refunded total.
        cumulativeRefundedCents: charge && charge.amount_refunded,
        chargeAmountCents: charge && charge.amount,
      });
    }
  } catch (e) {
    console.warn('[billing] credit clawback:', e.message);
  }

  return insertId;
}

async function markSubscriptionAtRisk(customerId, reason) {
  if (!customerId) return;
  const rows = await query('SELECT id, stripe_subscription_id FROM users WHERE stripe_customer_id = :cid LIMIT 1', {
    cid: String(customerId),
  });
  if (!rows[0]) return;
  console.warn('[billing] risk event for customer', customerId, reason, 'user', rows[0].id);
  try {
    const members = await query(
      `SELECT workspace_id FROM workspace_members WHERE user_id = :uid AND role IN ('owner','admin','member')`,
      { uid: rows[0].id }
    );
    for (const m of members || []) {
      await credits.freezeWorkspaceCredits(m.workspace_id, `risk_${reason || 'flag'}`);
    }
  } catch (e) {
    console.warn('[billing] credit freeze on risk:', e.message);
  }
}

async function fulfillCreditsCheckout(session) {
  if (!session || session.mode !== 'payment') return;
  const purpose = session.metadata && session.metadata.purpose;
  if (String(purpose || '') !== 'credits') return;
  // Expand line_items when missing so pack quantity can be recomputed.
  let sess = session;
  if (!session.line_items || !session.line_items.data) {
    try {
      const stripe = await getStripe();
      sess = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
    } catch {
      /* use metadata only */
    }
  }
  await credits.grantFromCheckoutSession(sess);
}

async function handleWebhookEvent(event, deps = {}) {
  const claimed = await claimStripeEvent(event);
  if (!claimed) {
    console.log('[billing] skip duplicate stripe event', event && event.id, event && event.type);
    return { duplicate: true };
  }

  try {
    await dispatchWebhookEvent(event, deps);
    await markStripeEventComplete(event && event.id);
    return { ok: true };
  } catch (e) {
    await releaseStripeEvent(event && event.id);
    throw e;
  }
}

async function dispatchWebhookEvent(event, deps = {}) {
  const type = event.type;
  const obj = event.data && event.data.object;

  if ((type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') && obj) {
    if (obj.mode === 'payment') {
      await fulfillCreditsCheckout(obj);
      return;
    }
    if (obj.mode === 'subscription' && obj.subscription) {
      const stripe = await getStripe();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      const userRef = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const planMeta = (obj.metadata && obj.metadata.plan) || '';
      if (userRef && !sub.metadata.user_id) {
        const meta = { user_id: String(userRef) };
        if (planMeta) meta.plan = String(planMeta);
        await stripe.subscriptions.update(
          subId,
          { metadata: meta },
          // Batch 154: webhook redeliveries replay the same update.
          {
            idempotencyKey: stripeIdempotencyKey('subscription-metadata', subId, String(userRef), String(planMeta || '')),
          }
        );
        sub.metadata = Object.assign({}, sub.metadata, meta);
      } else if (planMeta && !sub.metadata.plan) {
        await stripe.subscriptions.update(
          subId,
          {
            metadata: Object.assign({}, sub.metadata || {}, { plan: String(planMeta) }),
          },
          {
            idempotencyKey: stripeIdempotencyKey('subscription-metadata', subId, '', String(planMeta)),
          }
        );
        sub.metadata = Object.assign({}, sub.metadata, { plan: String(planMeta) });
      }
      await syncSubscription(sub);
      // Domain purchase flow (Batch 15): a checkout carrying a domain
      // transaction id marks it paid + notifies the admin. Best-effort —
      // a domain-flow failure must never fail the billing webhook.
      if (obj.metadata && obj.metadata.domain_transaction_id) {
        try {
          await require('./domainFlow').onDomainCheckoutPaid(obj);
        } catch (e) {
          console.warn('[billing] domain flow paid hook:', e.message);
        }
      }
    }
    return;
  }

  if (type.startsWith('customer.subscription.') && obj) {
    await syncSubscription(obj);
    // Batch 119: suspension transitions (server/subscriptionSuspension.js).
    // Status 'unpaid' means Stripe's automatic retries are exhausted —
    // the account suspends (serve-time 503 on its sites, portal narrowed
    // to billing, weekly renewal emails). A return to active/trialing
    // (the customer fixed their card and the invoice settled) restores.
    // Deleted terminates the episode and the Batch 37 termination path
    // below owns the account from there. Best-effort, like every hook
    // in this dispatcher: a suspension failure never fails the webhook.
    try {
      const suspension = require('./subscriptionSuspension');
      if (type === 'customer.subscription.deleted') {
        await suspension.terminateForSubscription(obj, deps);
      } else if (String(obj.status || '') === 'unpaid') {
        await suspension.suspendForSubscription(obj, deps);
      } else if (String(obj.status || '') === 'active' || String(obj.status || '') === 'trialing') {
        await suspension.restoreForSubscriptionEvent(obj, deps);
      }
    } catch (e) {
      console.warn('[billing] suspension transition:', e.message);
    }
    // Batch 37: the subscription has ENDED (a period-end cancellation
    // concluding, or dunning exhaustion) — the owner's website comes
    // offline now, not before. subscription.updated (which is how a
    // scheduled cancel arrives) deliberately does NOT reach this.
    // Best-effort like the domain-flow hook above: a site-disable
    // failure must never fail the billing webhook.
    if (type === 'customer.subscription.deleted') {
      let disableResult = null;
      try {
        disableResult = await disableSitesForEndedSubscription(obj, deps);
      } catch (e) {
        console.warn('[billing] subscription-end site disable:', e.message);
      }
      // Batch 63: post-termination notice — what was archived, what
      // state the domains are in, how to come back. Rides the disable
      // result (the orphan guard inside suppresses the email for a
      // subscription that was never the user's live plan).
      if (disableResult) {
        try {
          await require('./lifecycleComms').sendTerminationNotice(obj, disableResult, deps);
        } catch (e) {
          console.warn('[billing] termination notice:', e.message);
        }
      }
    }
    // Batch 60: re-derive domain renewal modes for the subscriber's
    // workspaces. syncSubscription above has already stored the new
    // state, so a cancel scheduled for period end keeps status
    // 'active' (renewal stays 'auto' for the whole paid period) while
    // a deleted subscription flips its domains to 'manual' and turns
    // registrar auto-renew OFF. Best-effort like the hooks above.
    try {
      await require('./domainRenewals').reconcileForSubscriptionEvent(obj, type, deps);
    } catch (e) {
      console.warn('[billing] domain renewal reconcile:', e.message);
    }
    // Batch 63: cancel confirmation when the cancel flag arrives via
    // the sync path (Stripe dashboard, or the echo of the in-app
    // flow) — lifecycleComms dedupes per subscription + period, so
    // the two paths can never double-send.
    if (obj.cancel_at_period_end) {
      try {
        await require('./lifecycleComms').sendCancelConfirmation(obj, deps);
      } catch (e) {
        console.warn('[billing] cancel confirmation email:', e.message);
      }
    }
    return;
  }

  if (type === 'invoice.paid' && obj) {
    const recorded = await recordPaymentFromInvoice(obj);
    let sub = null;
    const paidSubId = invoiceSubscriptionId(obj);
    if (paidSubId) {
      const stripe = await getStripe();
      const subId = paidSubId;
      sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
      // Batch 60: a paid invoice is the activation / renewal /
      // reactivation signal — reconcile domain renewal modes so a
      // (re)subscribed owner's domains go back to 'auto'.
      try {
        await require('./domainRenewals').reconcileForSubscriptionEvent(
          sub,
          'customer.subscription.updated',
          deps
        );
      } catch (e) {
        console.warn('[billing] domain renewal reconcile (invoice.paid):', e.message);
      }
    }
    // Batch 119: a settled invoice restores a suspended account —
    // serve markers cleared, weekly emails stop. (The subscription's
    // own return to 'active' lands on the same restore.) Best-effort.
    try {
      await require('./subscriptionSuspension').restoreForInvoice(obj, deps);
    } catch (e) {
      console.warn('[billing] suspension restore (invoice.paid):', e.message);
    }
    // Batch 37: monthly renewal email — ONLY on a genuine subscription
    // cycle renewal whose payment row was newly inserted (the dedupe in
    // recordPaymentFromInvoice), never for the first payment, and never
    // twice. Best-effort: a mail failure must never fail the webhook.
    if (recorded && recorded.inserted) {
      try {
        await sendRenewalEmailForInvoice(obj, { subscription: sub, deps });
      } catch (e) {
        console.warn('[billing] renewal email:', e.message);
      }
      // Batch 63: plan-only first-payment receipt. The renewal sender
      // above deliberately excludes billing_reason
      // 'subscription_create'; this covers it, cross-checked inside
      // against the domain flow so a domain signup is never emailed
      // twice about the same payment.
      try {
        await require('./lifecycleComms').sendFirstPaymentReceipt(obj, { subscription: sub, deps });
      } catch (e) {
        console.warn('[billing] first payment receipt:', e.message);
      }
    }
    // Batch 80: partner commission — a subscription payment collected
    // from a customer in a partner's workspace credits the partner's
    // earnings ledger (exactly once per invoice; the ledger's unique
    // credit_key is the guard, so this runs on every dispatch).
    // Best-effort: a credit failure must never fail the webhook.
    if (recorded && recorded.id) {
      try {
        await require('./partners').creditForInvoicePaid(obj, { paymentId: recorded.id });
      } catch (e) {
        console.warn('[billing] partner credit:', e.message);
      }
    }
    return;
  }

  if (type === 'invoice.payment_failed' && obj) {
    await recordPaymentFromInvoice(obj);
    const failedSubId = invoiceSubscriptionId(obj);
    if (failedSubId) {
      const stripe = await getStripe();
      const subId = failedSubId;
      const sub = await stripe.subscriptions.retrieve(subId);
      await syncSubscription(sub);
    }
    // Batch 63: failed-payment email. Access continues while Stripe
    // retries (past_due is an active status here) and the copy says
    // exactly that. Deduped per invoice inside lifecycleComms.
    try {
      await require('./lifecycleComms').sendPaymentFailedEmail(obj, deps);
    } catch (e) {
      console.warn('[billing] payment failed email:', e.message);
    }
    // Batch 119: next_payment_attempt null means Stripe will NOT
    // retry this invoice again — dunning is exhausted. If the
    // subscription still exists in a failed state (past_due/unpaid),
    // the account suspends now; the subscription.updated → 'unpaid'
    // event lands on the same idempotent path as a backstop. When
    // the Stripe account cancels on exhaustion instead, the sub is
    // already 'canceled' here and the termination path owns it.
    if (obj.next_payment_attempt == null && failedSubId) {
      try {
        const stripe = await getStripe();
        const subId = failedSubId;
        const sub = await stripe.subscriptions.retrieve(subId);
        const st = String((sub && sub.status) || '');
        if (st === 'past_due' || st === 'unpaid') {
          await require('./subscriptionSuspension').suspendForSubscription(sub, deps);
        }
      } catch (e) {
        console.warn('[billing] suspension on final failure:', e.message);
      }
    }
    return;
  }

  if (type === 'charge.refunded' && obj) {
    const refunds = (obj.refunds && obj.refunds.data) || [];
    for (const r of refunds) {
      await recordRefundFromCharge(obj, r);
      // Batch 80: reverse the partner commission for this refund
      // (proportional to the charge's total refunded amount; exactly
      // once per refund id). Best-effort like the other hooks.
      try {
        await require('./partners').reverseForRefund({
          refundId: r.id,
          invoiceId: obj.invoice || null,
          chargeId: obj.id,
          chargeAmountCents: obj.amount,
          amountRefundedCents: obj.amount_refunded,
        });
      } catch (e) {
        console.warn('[billing] partner refund reversal:', e.message);
      }
    }
    return;
  }

  if (type === 'charge.dispute.created' && obj) {
    await markSubscriptionAtRisk(obj.customer, 'dispute');
    // Batch 80: a dispute reverses the partner commission on the
    // disputed charge in full. Best-effort.
    try {
      await require('./partners').reverseForDispute({
        disputeId: obj.id,
        chargeId: typeof obj.charge === 'string' ? obj.charge : (obj.charge && obj.charge.id) || null,
      });
    } catch (e) {
      console.warn('[billing] partner dispute reversal:', e.message);
    }
    return;
  }

  if (type === 'radar.early_fraud_warning.created' && obj) {
    const chargeId = typeof obj.charge === 'string' ? obj.charge : obj.charge && obj.charge.id;
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
  const labelPro = await platform.getPlatformSetting('billing.amount_label_pro', 'Pro · monthly');
  const labelPrem = await platform.getPlatformSetting('billing.amount_label_premium', 'Premium · monthly');
  return listPlans().map((p) => {
    const extras = {};
    if (p.id === PLAN_STANDARD) {
      extras.priceLabel = labelStd;
      extras.priceConfigured = !!prices.standard;
      extras.checkout = true;
    } else if (p.id === PLAN_PRO) {
      extras.priceLabel = labelPro;
      extras.priceConfigured = !!prices.pro;
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

async function billingSummary(userId, opts = {}) {
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
  const healthyPaid = isHealthyPaid(user);
  const workspaceId = await resolveWorkspaceIdForUser(userId, opts.workspaceId);
  let creditInfo;
  if (workspaceId) {
    creditInfo = await credits.summaryForWorkspace(workspaceId);
  } else {
    const cfg = await credits.packConfig();
    creditInfo = {
      balance: 0,
      packAmount: cfg.packAmount,
      packLabel: cfg.packLabel,
      priceConfigured: cfg.configured,
      perSocialImage: cfg.perImage,
      perSocialContent: cfg.perContent,
      recent: [],
    };
  }
  let cancelAtPeriodEnd = false;
  if (isSubscribed(user) && user.stripe_subscription_id) {
    const live = await getLiveSubscription(user);
    cancelAtPeriodEnd = !!(live && live.cancel_at_period_end);
  }
  // Batch 119: an active suspension episode rides the summary so the
  // staff shell can banner it and the Billing page can explain it.
  let suspension = null;
  try {
    const row = await require('./subscriptionSuspension').getActiveSuspensionForUser(userId);
    if (row) {
      suspension = {
        suspendedAt: row.suspended_at || null,
        reason: row.reason || null,
        subscriptionId: row.subscription_id || null,
      };
    }
  } catch {
    /* the summary must never fail on the suspension read */
  }
  return {
    email: user.email,
    name: user.name,
    isSuperAdmin: Number(user.is_super_admin) === 1,
    subscriptionStatus: user.subscription_status || 'none',
    subscribed: isSubscribed(user),
    suspended: !!suspension,
    suspension,
    healthyPaid,
    pastDue: String(user.subscription_status || '') === 'past_due',
    productAccess,
    plan: planId,
    planName: plan.name,
    entitlements: { ...plan.entitlements },
    currentPeriodEnd: user.current_period_end,
    cancelAtPeriodEnd,
    stripeCustomerId: user.stripe_customer_id || null,
    hasCustomer: !!user.stripe_customer_id,
    hasActiveSubscription: isSubscribed(user) && !!user.stripe_subscription_id,
    priceId: prices.standard || null,
    priceIds: prices,
    publishableKey: (await getPublishableKey()) || null,
    amountLabel,
    requireSubscription: requireSub,
    plans: await catalogForApi(),
    payments,
    workspaceId,
    credits: creditInfo,
  };
}

async function listPayments({ limit = 100, q = '' } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (String(q || '').trim()) {
    // Batch 191: LIKE escape char is '!' — a backslash ESCAPE literal is not
    // dialect-safe (MySQL parses a lone backslash in a string literal as an
    // escaped quote -> unterminated string; SQLite reads the doubled form as
    // a 2-char escape and errors). '!' is one plain char on both dialects.
    const like = `%${String(q).trim().replace(/[!%_]/g, (c) => `!${c}`)}%`; // Batch 180 (L13)
    return query(
      `SELECT p.*, u.email AS user_email
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE u.email LIKE :like ESCAPE '!' OR p.stripe_invoice_id LIKE :like ESCAPE '!' OR p.stripe_charge_id LIKE :like ESCAPE '!'
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

  // Batch 154: one refund operation per (payment, amount, reason) —
  // a retried admin refund replays the original refund instead of
  // refunding twice.
  const refundKey = stripeAttemptKey('refund-admin', payment.id, params.amount != null ? params.amount : 'full', params.reason);
  let refund;
  if (payment.stripe_charge_id) {
    params.charge = payment.stripe_charge_id;
    refund = await stripe.refunds.create(params, { idempotencyKey: refundKey });
  } else {
    params.payment_intent = payment.stripe_payment_intent_id;
    refund = await stripe.refunds.create(params, { idempotencyKey: refundKey });
  }

  // Batch 180 (M5): a payment-intent-only payment (every credits
  // pack — its payments row carries stripe_charge_id NULL) must
  // still record its refund LINKED, or the credits clawback never
  // runs. Resolve the real charge through the payment intent
  // (latest_charge); when Stripe lookup is unavailable, synthesize
  // a stub that at minimum carries the payment_intent (the linkage
  // recordRefundFromCharge finds the payment by), the charge
  // amount, and the cumulative refunded total — never the pre-fix
  // { id: null } stub that wrote an unlinked refunds row and
  // poisoned the real charge.refunded webhook into early-return.
  let charge = null;
  if (payment.stripe_charge_id) {
    charge = await stripe.charges.retrieve(payment.stripe_charge_id);
  } else if (payment.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
      const latestCharge = pi && (typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id);
      if (latestCharge) charge = await stripe.charges.retrieve(latestCharge);
    } catch {
      charge = null;
    }
    if (!charge) {
      let priorRefunded = 0;
      try {
        const prior = await query(
          'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE payment_id = :pid',
          { pid: payment.id }
        );
        priorRefunded = Number(prior[0] && prior[0].total) || 0;
      } catch {
        priorRefunded = 0;
      }
      charge = {
        id: null,
        payment_intent: payment.stripe_payment_intent_id,
        amount: Number(payment.amount_cents) || 0,
        amount_refunded: priorRefunded + (Number(refund.amount) || 0),
        currency: payment.currency,
        customer: null,
        refunds: { data: [refund] },
      };
    }
  }

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
    const admins = await query(
      "SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1 AND (status = 'active' OR status IS NULL)"
    );
    if (Number(admins[0].c) <= 1) {
      throw Object.assign(new Error('Cannot delete the last super admin'), { code: 'LAST_SUPER_ADMIN' });
    }
  }

  if (user.stripe_subscription_id) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(
        user.stripe_subscription_id,
        {
          invoice_now: false,
          prorate: !!immediate,
        },
        {
          idempotencyKey: stripeAttemptKey('subscription-cancel', user.stripe_subscription_id, `prorate=${!!immediate}`),
        }
      );
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
  HEALTHY_PAID_STATUSES,
  getUserBilling,
  isSubscribed,
  isHealthyPaid,
  assertNotPastDue,
  planOfUser,
  hasProductAccess,
  requireSubscriptionEnabled,
  workspaceHasSubscription,
  workspaceHasProductAccess,
  workspacePlan,
  effectivePlan,
  claimStripeEvent,
  markStripeEventComplete,
  ensureCustomer,
  createCheckoutSession,
  createCreditsCheckoutSession,
  createPortalSession,
  getLiveSubscription,
  scheduleCancelAtPeriodEnd,
  resumeSubscription,
  changeSubscriptionPlan,
  startOrChangePlan,
  resolveWorkspaceIdForUser,
  syncSubscription,
  handleWebhookEvent,
  sendRenewalEmailForInvoice,
  disableSitesForEndedSubscription,
  resolveUserSites,
  billingSummary,
  catalogForApi,
  listPayments,
  listRefunds,
  adminRefundPayment,
  deleteAccount,
  recordPaymentFromInvoice,
};
