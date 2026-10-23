'use strict';

/**
 * Per-workspace (tenant) Stripe access for the Shop module.
 *
 * Each workspace stores its OWN Stripe credentials in workspace settings
 * (shop.stripe.publishable_key / shop.stripe.secret_key /
 * shop.stripe.webhook_secret). Secret values are encrypted at rest via
 * src/secretBox (M6) and decrypted here on read. Money flows directly
 * between the customer and the workspace owner's Stripe account — the
 * platform never holds tenant funds. This is separate from
 * server/stripeClient.js, which is the PLATFORM's own billing account.
 */

const Stripe = require('stripe');

let cached = { key: null, client: null };

function getSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && typeof row.value === 'string' ? require('../src/secretBox').decryptSetting(key, row.value) : null;
  } catch {
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

module.exports = { getCredentials, isConfigured, getClient, constructEvent };
