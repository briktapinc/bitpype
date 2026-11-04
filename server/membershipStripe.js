'use strict';

/**
 * Per-LEAD Stripe access for paid memberships (Batch 17).
 *
 * Mirrors server/shopStripe.js, but the credentials belong to the SITE
 * OWNER's own Stripe account and are scoped to their lead: owners save
 * them in the portal (Members → Payments). Money flows directly between
 * the member and the site owner's Stripe account — the platform never
 * holds it, and the admin panel only ever READS payout state for
 * oversight.
 *
 * Batch 129: the credentials resolve through the ONE unified payments
 * config (server/paymentsConfig.js) — the unified row first, the
 * pre-129 membership_stripe_keys store as a read-only fallback. This
 * module is the membership-purpose adapter: tier prices, subscription
 * checkout support, origin-aware subscription cancel, payout reads.
 *
 * This module is the only Stripe-touching membership layer: the gate
 * and all entitlement reads run on local member_subscriptions rows.
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const siteModules = require('./siteModules');
// Batch 129: the credentials this adapter resolves come from the ONE
// payments config (server/paymentsConfig.js) — the unified row
// first, the pre-129 membership key store as fallback. Memberships
// never resolve to the workspace account (unchanged Batch 17 rule).
const paymentsConfig = require('./paymentsConfig');

const clientCache = new Map(); // `${leadId}:${keyFingerprint}` -> Stripe client
const payoutCache = new Map(); // leadId -> { at: epochMs, value }
const PAYOUT_CACHE_MS = 10 * 60 * 1000;

function notConfigured(message) {
  const e = new Error(message || 'This site has not connected its own Stripe account for memberships yet.');
  e.code = 'MEMBERSHIP_STRIPE_NOT_CONFIGURED';
  e.status = 409;
  return e;
}

/** Decrypted credentials for one lead (server-side only, never exported whole).
 *  Batch 129: the effective membership-purpose layer — unified config
 *  first, membership legacy second. */
function getCredentials(db, leadId) {
  const layer = paymentsConfig
    .layersFor(db, leadId, 'membership')
    .find((l) => l.secretKey || l.publishableKey || l.webhookSecret);
  if (!layer) return { publishableKey: '', secretKey: '', webhookSecret: '' };
  return {
    publishableKey: layer.publishableKey || '',
    secretKey: layer.secretKey || '',
    webhookSecret: layer.webhookSecret || '',
  };
}

function isConnected(db, leadId) {
  return !!getCredentials(db, leadId).secretKey;
}

/** Stripe SDK client bound to the site owner's own secret key. */
function getClient(db, leadId) {
  const { secretKey } = getCredentials(db, leadId);
  if (!secretKey) throw notConfigured();
  const fingerprint = crypto.createHash('sha256').update(secretKey).digest('hex').slice(0, 12);
  const cacheKey = `${Number(leadId)}:${fingerprint}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new Stripe(secretKey, { timeout: 15000, maxNetworkRetries: 1 });
    clientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Verify a webhook payload against ONE lead's membership-purpose
 * webhook secrets and return the parsed event. Batch 129: tries the
 * unified secret first, then the membership legacy secret — an event
 * for a subscription created under the retired store still verifies.
 * Throws MEMBERSHIP_STRIPE_NOT_CONFIGURED when the lead has no
 * membership-purpose webhook secret, or a Stripe signature error
 * otherwise.
 */
function constructEventForLead(db, leadId, rawBody, signature) {
  const candidates = paymentsConfig
    .webhookCandidates(db, leadId, 'membership')
    .filter((c) => c.source === 'unified' || c.source === 'membership');
  if (!candidates.length) {
    throw notConfigured('Membership webhooks are not configured for this site.');
  }
  let lastError = null;
  for (const cand of candidates) {
    try {
      const client = cand.secretKey
        ? paymentsConfig.clientForLayer(leadId, cand.source, cand.secretKey)
        : getClient(db, leadId);
      return client.webhooks.constructEvent(rawBody, signature, cand.webhookSecret);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Webhook signature verification failed');
}

/**
 * Pick which lead an (unverified) event belongs to, so the webhook can
 * verify it against that lead's own secret. The peeked values are used
 * ONLY to select the verification key — nothing is applied until the
 * signature check passes. Resolution order: our checkout/subscription
 * metadata, then the local subscription row by Stripe subscription id
 * (invoice events), then by Stripe customer id.
 */
function resolveLeadForEvent(db, eventLike) {
  siteModules.ensureTables(db);
  const obj = (eventLike && eventLike.data && eventLike.data.object) || {};
  const meta = obj.metadata || {};
  const fromMeta = Number(meta.bitpype_lead_id);
  if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta;
  const subId = String(obj.subscription || (obj.object === 'subscription' ? obj.id : '') || '');
  if (subId) {
    const leadId = siteModules.findLeadByStripeSubscription(db, subId);
    if (leadId) return leadId;
  }
  if (obj.id && String(obj.id).startsWith('sub_')) {
    const leadId = siteModules.findLeadByStripeSubscription(db, String(obj.id));
    if (leadId) return leadId;
  }
  const customer = String(obj.customer || '');
  if (customer) {
    const leadId = siteModules.findLeadByStripeCustomer(db, customer);
    if (leadId) return leadId;
  }
  return null;
}

/**
 * Create (or reuse) the tier's Product on the owner's Stripe and mint a
 * NEW recurring Price for the tier's current amount/interval. Stripe
 * prices are immutable, so a price/interval change means a new Price;
 * the old one is left alone (existing subscribers keep it).
 */
async function ensureTierStripePrice(db, leadId, tier) {
  const stripe = getClient(db, leadId); // throws when not connected
  let productId = tier.stripe_product_id || '';
  if (productId) {
    try {
      const existing = await stripe.products.retrieve(productId);
      if (!existing || existing.deleted) productId = '';
    } catch {
      productId = '';
    }
  }
  if (!productId) {
    const product = await stripe.products.create({
      name: tier.name,
      ...(tier.description ? { description: String(tier.description).slice(0, 500) } : {}),
      metadata: { bitpype_lead_id: String(leadId), bitpype_tier_id: String(tier.id) },
    });
    productId = String(product.id || '');
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: Number(tier.price_cents) || 0,
    recurring: { interval: tier.interval === 'year' ? 'year' : 'month' },
    metadata: { bitpype_lead_id: String(leadId), bitpype_tier_id: String(tier.id) },
  });
  return { stripe_product_id: productId, stripe_price_id: String(price.id || '') };
}

/**
 * Save a tier end-to-end — the ONE path the portal and MCP both use.
 * Paid tier + keys connected: the Stripe Price is created BEFORE the
 * row is persisted, so a Stripe rejection surfaces the real error and
 * leaves nothing half-saved. Paid tier without keys: the tier saves
 * INACTIVE with stripe_state 'not_connected'. Free tiers never touch
 * Stripe.
 */
async function saveMembershipTier(db, leadId, data = {}, tierId = null) {
  const id = Number(leadId);
  const existing = tierId ? siteModules.getMembershipTier(db, id, tierId) : null;
  if (tierId && !existing) {
    const e = new Error('Tier not found');
    e.code = 'NOT_FOUND';
    e.status = 404;
    throw e;
  }
  const fields = siteModules.validateMembershipTierInput(db, id, data, existing);
  const wantActive = data.active != null ? !!data.active : existing ? existing.active : true;
  const isPaid = fields.price_cents > 0;

  if (!isPaid) {
    const opts = { active: wantActive };
    const tier = existing
      ? siteModules.updateMembershipTierRow(db, id, existing.id, fields, opts)
      : siteModules.insertMembershipTier(db, id, fields, opts);
    return { tier, stripe_state: 'free' };
  }

  if (!isConnected(db, id)) {
    const opts = { active: false };
    const tier = existing
      ? siteModules.updateMembershipTierRow(db, id, existing.id, fields, opts)
      : siteModules.insertMembershipTier(db, id, fields, opts);
    return { tier, stripe_state: 'not_connected' };
  }

  const priceChanged =
    !existing ||
    !existing.stripe_price_id ||
    Number(existing.price_cents) !== fields.price_cents ||
    existing.interval !== fields.interval;
  let stripeIds = {
    stripe_product_id: existing ? existing.stripe_product_id : '',
    stripe_price_id: existing ? existing.stripe_price_id : '',
  };
  if (priceChanged) {
    // Stripe first: on rejection this throws the real error and the
    // caller persists nothing.
    stripeIds = await ensureTierStripePrice(db, id, { ...fields, id: existing ? existing.id : 0 });
  }
  const tier = existing
    ? siteModules.updateMembershipTierRow(db, id, existing.id, fields, { ...stripeIds, active: wantActive })
    : siteModules.insertMembershipTier(db, id, fields, { ...stripeIds, active: wantActive });
  return { tier, stripe_state: 'connected' };
}

/**
 * Cancel a member's subscription at period end on the OWNER's Stripe.
 * The local row is marked canceling immediately (cancel_at_period_end)
 * while its status — and the member's access — lasts until Stripe ends
 * the period and the webhook lands the terminal state. Free-tier joins
 * have no Stripe subscription and cancel locally at once.
 */
async function cancelMemberSubscription(db, leadId, memberId) {
  const id = Number(leadId);
  const subs = siteModules.listMemberSubscriptions(db, id, { memberId: Number(memberId), limit: 50 });
  const sub =
    subs.find((s) => siteModules.MEMBER_ENTITLED_STATUSES.includes(s.status) && s.stripe_subscription_id) ||
    subs.find((s) => siteModules.MEMBER_ENTITLED_STATUSES.includes(s.status)) ||
    null;
  if (!sub) {
    const e = new Error('This member has no active subscription to cancel.');
    e.code = 'NOT_FOUND';
    e.status = 404;
    throw e;
  }
  if (!sub.stripe_subscription_id) {
    return { subscription: siteModules.cancelLocalSubscription(db, sub.id), stripe_called: false };
  }
  // Batch 129 — origin-aware cancel. A subscription lives on the
  // Stripe account that CREATED it; if the owner later unified the
  // payments config onto a different account, cancelling through the
  // currently-resolved client would 404 (or worse, act on the wrong
  // account). Try the subscription's origin layer first (pre-129
  // subscriptions have no recorded source and were created under the
  // membership keys BY DEFINITION, so the membership legacy layer
  // leads for them), then the other layer; only when every candidate
  // fails does the first error surface.
  const origin = String(sub.stripe_key_source || '');
  const unifiedCreds = paymentsConfig.getUnifiedCredentials(db, id);
  const legacyCreds = paymentsConfig.getMembershipLegacyCredentials(db, id);
  const ordered =
    origin === 'unified'
      ? [
          { source: 'unified', creds: unifiedCreds },
          { source: 'membership', creds: legacyCreds },
        ]
      : [
          { source: 'membership', creds: legacyCreds },
          { source: 'unified', creds: unifiedCreds },
        ];
  const usable = ordered.filter((c) => c.creds && c.creds.secretKey);
  if (!usable.length) throw notConfigured();
  let firstError = null;
  for (const cand of usable) {
    try {
      const stripe = paymentsConfig.clientForLayer(id, cand.source, cand.creds.secretKey);
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
      return { subscription: siteModules.markSubscriptionCanceling(db, sub.id), stripe_called: true };
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  throw firstError;
}

function sumAmounts(list) {
  let total = 0;
  for (const entry of Array.isArray(list) ? list : []) total += Number(entry.amount) || 0;
  return total;
}

/**
 * Oversight read for the admin panel: the owner's Stripe balance +
 * latest payout, fetched server-side with THEIR keys. Cached 10
 * minutes (successes and failures alike); a failure returns
 * { ok: false } and never throws — the screen renders "unavailable".
 */
async function getPayoutStatus(db, leadId, opts = {}) {
  const id = Number(leadId);
  const cached = payoutCache.get(id);
  if (!opts.force && cached && Date.now() - cached.at < PAYOUT_CACHE_MS) return cached.value;
  let value;
  if (!isConnected(db, id)) {
    value = { ok: false, reason: 'not_connected', as_of: new Date().toISOString() };
  } else {
    try {
      const stripe = getClient(db, id);
      const balance = await stripe.balance.retrieve();
      let lastPayout = null;
      try {
        const payouts = await stripe.payouts.list({ limit: 1 });
        const p = payouts && Array.isArray(payouts.data) ? payouts.data[0] : null;
        if (p) {
          lastPayout = {
            amount_cents: Number(p.amount) || 0,
            currency: String(p.currency || 'usd').toUpperCase(),
            status: String(p.status || ''),
            arrival_date: p.arrival_date
              ? new Date(Number(p.arrival_date) * 1000).toISOString()
              : null,
          };
        }
      } catch {
        lastPayout = null;
      }
      const available = Array.isArray(balance.available) ? balance.available : [];
      const pending = Array.isArray(balance.pending) ? balance.pending : [];
      const currency = String((available[0] && available[0].currency) || 'usd').toUpperCase();
      value = {
        ok: true,
        currency,
        available_cents: sumAmounts(available),
        pending_cents: sumAmounts(pending),
        last_payout: lastPayout,
        as_of: new Date().toISOString(),
      };
    } catch {
      value = { ok: false, reason: 'unavailable', as_of: new Date().toISOString() };
    }
  }
  payoutCache.set(id, { at: Date.now(), value });
  return value;
}

module.exports = {
  getCredentials,
  isConnected,
  getClient,
  constructEventForLead,
  resolveLeadForEvent,
  ensureTierStripePrice,
  saveMembershipTier,
  cancelMemberSubscription,
  getPayoutStatus,
  notConfigured,
  PAYOUT_CACHE_MS,
};
