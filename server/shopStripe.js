'use strict';

/**
 * Stripe access for the Shop module — two key layers.
 *
 * WORKSPACE keys (original): each workspace stores its OWN Stripe
 * credentials in workspace settings (shop.stripe.publishable_key /
 * shop.stripe.secret_key / shop.stripe.webhook_secret), saved by staff
 * in Admin → Settings → Shop payments. Secret values are encrypted at
 * rest via src/secretBox (M6) and decrypted here on read.
 *
 * PER-LEAD keys (Batch 19, mirroring membershipStripe): the SITE
 * OWNER's own Stripe keys, saved by the owner in the portal
 * (Shop → Payments) and stored secretBox-encrypted in
 * shop_stripe_keys, scoped to their lead. Checkout PREFERS the lead's
 * keys and falls back to the workspace keys, so shops already running
 * on workspace keys are unaffected; every order records which
 * key-set ran it (ecommerce_orders.stripe_key_source).
 *
 * Money always flows directly between the customer and a Stripe
 * account the business controls — the platform never holds tenant
 * funds. This is separate from server/stripeClient.js, which is the
 * PLATFORM's own billing account.
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const siteModules = require('./siteModules');
const secretBox = require('../src/secretBox');

let cached = { key: null, client: null };
const leadClientCache = new Map(); // `${leadId}:${keyFingerprint}` -> Stripe client

/* ── Workspace keys ── */

function getSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && typeof row.value === 'string' ? secretBox.decryptSetting(key, row.value) : null;
  } catch (e) {
    console.warn('[shopStripe] getSetting:', e.message || e);
    return null;
  }
}

function getCredentials(db) {
  return {
    publishableKey: String(getSetting(db, 'shop.stripe.publishable_key') || '').trim(),
    secretKey: String(getSetting(db, 'shop.stripe.secret_key') || '').trim(),
    webhookSecret: String(getSetting(db, 'shop.stripe.webhook_secret') || '').trim(),
  };
}

/** True when the workspace has a Stripe secret key on file. */
function isConfigured(db) {
  return !!getCredentials(db).secretKey;
}

function notConfigured(message) {
  const e = new Error(message);
  e.code = 'SHOP_STRIPE_NOT_CONFIGURED';
  e.status = 409;
  return e;
}

/** Stripe SDK client bound to the workspace's own secret key. */
function getClient(db) {
  const { secretKey } = getCredentials(db);
  if (!secretKey) {
    throw notConfigured('Stripe is not configured for this shop (Settings → Shop payments).');
  }
  if (cached.client && cached.key === secretKey) return cached.client;
  // Bounded timeout/retries: a shopper's browser is waiting on this call.
  const client = new Stripe(secretKey, { timeout: 15000, maxNetworkRetries: 1 });
  cached = { key: secretKey, client };
  return client;
}

/**
 * Verify a webhook payload against the workspace's webhook secret and
 * return the parsed event. Throws SHOP_STRIPE_NOT_CONFIGURED when the
 * shop has no credentials, or a Stripe signature error (callers map it
 * to HTTP 400).
 */
function constructEvent(db, rawBody, signature) {
  const { webhookSecret } = getCredentials(db);
  if (!webhookSecret) {
    throw notConfigured('Stripe webhooks are not configured for this shop (Settings → Shop payments).');
  }
  return getClient(db).webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/* ── Per-lead keys (Batch 19) ── */

/** Decrypted credentials for one lead (server-side only, never exported whole). */
function getLeadCredentials(db, leadId) {
  siteModules.ensureTables(db);
  const row = siteModules.getShopStripeKeyRow(db, Number(leadId));
  const dec = (v) => {
    if (!v) return '';
    try {
      return String(secretBox.decryptValue(v) || '').trim();
    } catch {
      return '';
    }
  };
  return {
    publishableKey: row ? String(row.publishable_key || '').trim() : '',
    secretKey: dec(row && row.secret_key_enc),
    webhookSecret: dec(row && row.webhook_secret_enc),
  };
}

/** True when this lead (site owner) has connected their own secret key. */
function isLeadConnected(db, leadId) {
  return !!getLeadCredentials(db, leadId).secretKey;
}

/** True when checkout can run for this lead on either key layer. */
function isConfiguredForLead(db, leadId) {
  return isLeadConnected(db, leadId) || isConfigured(db);
}

function clientForSecret(secretKey) {
  return new Stripe(secretKey, { timeout: 15000, maxNetworkRetries: 1 });
}

/** Stripe SDK client bound to the site owner's own secret key. */
function getLeadClient(db, leadId) {
  const { secretKey } = getLeadCredentials(db, leadId);
  if (!secretKey) throw notConfigured('This site has not connected its own Stripe account for its shop yet.');
  const fingerprint = crypto.createHash('sha256').update(secretKey).digest('hex').slice(0, 12);
  const cacheKey = `${Number(leadId)}:${fingerprint}`;
  let client = leadClientCache.get(cacheKey);
  if (!client) {
    client = clientForSecret(secretKey);
    leadClientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * The ONE checkout resolution: the lead's own keys win, the workspace
 * keys are the fallback. Returns { source: 'lead'|'workspace',
 * client, publishableKey }. Throws SHOP_STRIPE_NOT_CONFIGURED when
 * neither layer has a secret key.
 */
function resolveForLead(db, leadId) {
  const lead = getLeadCredentials(db, leadId);
  if (lead.secretKey) {
    return { source: 'lead', client: getLeadClient(db, leadId), publishableKey: lead.publishableKey };
  }
  const ws = getCredentials(db);
  if (ws.secretKey) {
    return { source: 'workspace', client: getClient(db), publishableKey: ws.publishableKey };
  }
  throw notConfigured(
    'Stripe is not configured for this shop. Connect your own Stripe keys in the portal (Shop → Payments), or ask BitPype to save workspace keys (Settings → Shop payments).'
  );
}

/** Convenience: just the client resolveForLead would use. */
function getClientForLead(db, leadId) {
  return resolveForLead(db, leadId).client;
}

/**
 * Verify a webhook payload against ONE lead's webhook secret.
 * Throws SHOP_STRIPE_NOT_CONFIGURED when the lead has none saved.
 */
function constructEventForLead(db, leadId, rawBody, signature) {
  const { webhookSecret } = getLeadCredentials(db, leadId);
  if (!webhookSecret) throw notConfigured('Shop webhooks are not configured for this site.');
  return getLeadClient(db, leadId).webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Pick which lead an (unverified) shop event belongs to, so the
 * webhook can try that lead's own secret first. The peeked values are
 * used ONLY to select the candidate verification key — nothing is
 * applied until a signature check passes. Resolution: checkout /
 * payment-intent metadata (bitpype_lead_id), then the local order row
 * via metadata bitpype_order_id, then via the checkout session id.
 */
function resolveLeadForEvent(db, eventLike) {
  siteModules.ensureTables(db);
  const obj = (eventLike && eventLike.data && eventLike.data.object) || {};
  const meta = obj.metadata || {};
  const fromMeta = Number(meta.bitpype_lead_id);
  if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta;
  const orderId = Number(meta.bitpype_order_id);
  if (Number.isInteger(orderId) && orderId > 0) {
    const row = db.prepare('SELECT lead_id FROM ecommerce_orders WHERE id = ?').get(orderId);
    if (row) return Number(row.lead_id);
  }
  if (obj.id && String(obj.id).startsWith('cs_')) {
    const order = siteModules.getShopOrderBySession(db, String(obj.id));
    if (order) return Number(order.lead_id);
  }
  return null;
}

/**
 * Verify an incoming shop webhook against the right secret. The
 * workspace is shared by many sites, so candidates are tried in
 * order — the resolved lead's own secret first (owners point their
 * Stripe webhook at the same URL), then the workspace secret (the
 * long-standing behavior, and the right one for orders placed on the
 * workspace fallback). A payload is only accepted when its signature
 * verifies against one of OUR secrets. Returns { event, source }.
 * Throws SHOP_STRIPE_NOT_CONFIGURED when no layer has a webhook
 * secret at all, or the last signature error when none verify.
 */
function constructEventForShop(db, rawBody, signature, peek) {
  const candidates = [];
  const leadId = peek ? resolveLeadForEvent(db, peek) : null;
  if (leadId && getLeadCredentials(db, leadId).webhookSecret) candidates.push('lead');
  if (getCredentials(db).webhookSecret) candidates.push('workspace');
  if (!candidates.length) {
    throw notConfigured('Stripe webhooks are not configured for this shop.');
  }
  let lastError = null;
  for (const source of candidates) {
    try {
      const event =
        source === 'lead'
          ? constructEventForLead(db, leadId, rawBody, signature)
          : constructEvent(db, rawBody, signature);
      return { event, source };
    } catch (e) {
      if (e && e.code === 'SHOP_STRIPE_NOT_CONFIGURED') throw e;
      lastError = e;
    }
  }
  throw lastError || new Error('Webhook signature verification failed');
}

/**
 * Portal "Test connection": one lightweight read (the account behind
 * the lead's saved secret key). Reports only facts about the owner's
 * OWN account — never key material. Throws the raw Stripe error on
 * rejection; the portal wrapper maps it to a truthful failure.
 */
async function testLeadConnection(db, leadId) {
  const client = getLeadClient(db, leadId); // throws SHOP_STRIPE_NOT_CONFIGURED
  const { secretKey } = getLeadCredentials(db, leadId);
  const account = await client.accounts.retrieve();
  const testMode = /^(sk|rk)_test_/.test(secretKey);
  return {
    ok: true,
    account_id: String(account.id || ''),
    test_mode: testMode,
    livemode: !testMode,
    charges_enabled: !!account.charges_enabled,
    payouts_enabled: !!account.payouts_enabled,
    business_name: String(
      (account.business_profile && account.business_profile.name) ||
        (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) ||
        ''
    ),
  };
}

module.exports = {
  getCredentials,
  isConfigured,
  getClient,
  constructEvent,
  getLeadCredentials,
  isLeadConnected,
  isConfiguredForLead,
  getLeadClient,
  resolveForLead,
  getClientForLead,
  constructEventForLead,
  resolveLeadForEvent,
  constructEventForShop,
  testLeadConnection,
  notConfigured,
};
