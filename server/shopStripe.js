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
 * (Shop → Payments) and stored secretBox-encrypted, scoped to their
 * lead. Checkout PREFERS the lead's keys and falls back to the
 * workspace keys, so shops already running on workspace keys are
 * unaffected; every order records which key-set ran it
 * (ecommerce_orders.stripe_key_source).
 *
 * Batch 129: the lead layer is now the ONE unified payments config
 * (server/paymentsConfig.js) — this module is the shop-purpose
 * adapter over it. Resolution: unified config → pre-129 shop key
 * store (read-only fallback) → workspace keys. Sources are
 * 'unified' | 'lead' | 'workspace'.
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
// Batch 129: the lead-side layers (unified config → shop legacy) are
// owned by server/paymentsConfig.js; this module is now the SHOP
// purpose adapter over it, plus the workspace layer below.
const paymentsConfig = require('./paymentsConfig');

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

/**
 * Batch 128 — the mode a secret key belongs to, from its prefix
 * alone ('test' | 'live' | null). Mode honesty matters: a test-mode
 * key can never take a real charge and a live key must never be
 * presented as a sandbox, so statuses report the mode the saved key
 * actually is — derived at read time, never a stored claim.
 */
function modeForSecret(secretKey) {
  // Batch 129: the canonical implementation lives in paymentsConfig.
  return paymentsConfig.modeForSecret(secretKey);
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

/* ── Per-lead keys (Batch 19; unified by Batch 129) ── */

/**
 * Decrypted credentials for one lead (server-side only, never
 * exported whole). Batch 129: the effective LEAD layer for the shop
 * purpose — the unified payments config first, the pre-129 shop key
 * store as fallback.
 */
function getLeadCredentials(db, leadId) {
  const layer = paymentsConfig
    .layersFor(db, leadId, 'shop')
    .find((l) => l.source !== 'workspace' && (l.secretKey || l.publishableKey || l.webhookSecret));
  if (!layer) return { publishableKey: '', secretKey: '', webhookSecret: '' };
  return {
    publishableKey: layer.publishableKey || '',
    secretKey: layer.secretKey || '',
    webhookSecret: layer.webhookSecret || '',
  };
}

/** True when this lead (site owner) has connected their own secret key on any lead layer. */
function isLeadConnected(db, leadId) {
  return paymentsConfig
    .layersFor(db, leadId, 'shop')
    .some((l) => l.source !== 'workspace' && !!l.secretKey);
}

/** True when checkout can run for this lead on either key layer. */
function isConfiguredForLead(db, leadId) {
  return isLeadConnected(db, leadId) || isConfigured(db);
}

function clientForSecret(secretKey) {
  return new Stripe(secretKey, { timeout: 15000, maxNetworkRetries: 1 });
}

/** Stripe SDK client bound to the site owner's own (effective lead-layer) secret key. */
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
 * The ONE checkout resolution: the lead's own config wins (Batch 129:
 * unified row first, shop legacy second), the workspace keys are the
 * fallback. Returns { source: 'unified'|'lead'|'workspace', mode,
 * client, publishableKey }. Throws SHOP_STRIPE_NOT_CONFIGURED when
 * no layer has a secret key.
 */
function resolveForLead(db, leadId) {
  const layer = paymentsConfig.resolve(db, leadId, 'shop');
  if (!layer) {
    throw notConfigured(
      'Stripe is not configured for this shop. Connect your own Stripe keys in the portal (Shop → Payments), or ask BitPype to save workspace keys (Settings → Shop payments).'
    );
  }
  if (layer.source === 'workspace') {
    return {
      source: 'workspace',
      mode: modeForSecret(layer.secretKey),
      client: getClient(db),
      publishableKey: layer.publishableKey,
    };
  }
  return {
    source: layer.source,
    mode: modeForSecret(layer.secretKey),
    client: paymentsConfig.clientForLayer(leadId, layer.source, layer.secretKey),
    publishableKey: layer.publishableKey,
  };
}

/** Convenience: just the client resolveForLead would use. */
function getClientForLead(db, leadId) {
  return resolveForLead(db, leadId).client;
}

/**
 * Batch 128 — the mode checkout would actually run in for this lead
 * right now (the same lead-first resolution as resolveForLead),
 * without building a client or throwing: 'test' | 'live' | null
 * when no layer has a secret key.
 */
function effectiveMode(db, leadId) {
  return paymentsConfig.effectiveMode(db, leadId, 'shop');
}

/**
 * Verify a webhook payload against ONE lead's shop-purpose webhook
 * secrets (Batch 129: unified first, then the shop legacy secret —
 * an event for a purchase made under the retired store still
 * verifies). Throws SHOP_STRIPE_NOT_CONFIGURED when the lead has no
 * shop-purpose webhook secret saved.
 */
function constructEventForLead(db, leadId, rawBody, signature) {
  const candidates = paymentsConfig
    .webhookCandidates(db, leadId, 'shop')
    .filter((c) => c.source !== 'workspace');
  if (!candidates.length) throw notConfigured('Shop webhooks are not configured for this site.');
  let lastError = null;
  for (const cand of candidates) {
    try {
      const client = cand.secretKey
        ? paymentsConfig.clientForLayer(leadId, cand.source, cand.secretKey)
        : getLeadClient(db, leadId);
      return client.webhooks.constructEvent(rawBody, signature, cand.webhookSecret);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Webhook signature verification failed');
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
  const leadId = peek ? paymentsConfig.resolveLeadForEvent(db, peek) : null;
  const candidates = leadId
    ? paymentsConfig.webhookCandidates(db, leadId, 'shop')
    : [{ source: 'workspace', webhookSecret: getCredentials(db).webhookSecret, secretKey: getCredentials(db).secretKey }];
  const usable = candidates.filter((c) => c.webhookSecret);
  if (!usable.length) {
    throw notConfigured('Stripe webhooks are not configured for this shop.');
  }
  let lastError = null;
  for (const cand of usable) {
    try {
      const client =
        cand.source === 'workspace'
          ? getClient(db)
          : cand.secretKey
            ? paymentsConfig.clientForLayer(leadId, cand.source, cand.secretKey)
            : getLeadClient(db, leadId);
      const event = client.webhooks.constructEvent(rawBody, signature, cand.webhookSecret);
      return { event, source: cand.source };
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
  // Batch 129: tests the RESOLVED lead layer (unified config first) —
  // the account a charge would actually run on.
  const resolved = paymentsConfig.resolve(db, leadId, 'shop');
  if (!resolved || resolved.source === 'workspace') {
    throw notConfigured('This site has not connected its own Stripe account for its shop yet.');
  }
  const client = paymentsConfig.clientForLayer(leadId, resolved.source, resolved.secretKey);
  const account = await client.accounts.retrieve();
  const testMode = modeForSecret(resolved.secretKey) === 'test';
  return {
    ok: true,
    account_id: String(account.id || ''),
    test_mode: testMode,
    livemode: !testMode,
    charges_enabled: !!account.charges_enabled,
    payouts_enabled: !!account.payouts_enabled,
    source: resolved.source,
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
  modeForSecret,
  effectiveMode,
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
