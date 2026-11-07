'use strict';

/**
 * Batch 154 (§9) — deterministic Stripe idempotency keys.
 *
 * Before this batch, NO outbound mutating Stripe call carried an
 * idempotency key: a network retry, a double submit, or a client
 * timeout-then-retry could create a second customer / checkout
 * session / refund for the SAME business operation.
 *
 * Every mutating call site now passes
 *   { idempotencyKey: stripeIdempotencyKey(<operation>, ...ids) }
 * where the parts are BUSINESS identifiers that already exist before
 * the call (user id, order id, payment id, subscription id, tier id,
 * lookup key, target amount/price) — never a timestamp, never a
 * random value. The same operation retried therefore derives the
 * SAME key and Stripe replays the original result instead of
 * duplicating the effect; a genuinely different operation (different
 * ids, different amount/price) derives a different key.
 *
 * Key shape: `bp154_<operation>_<sha256 of the parts>` — the digest
 * keeps keys bounded and free of any PII (emails, names) while the
 * operation prefix keeps Stripe-dashboard / log correlation readable.
 * Stripe retains idempotency results for 24 hours; after that window
 * the same key may execute again, which is exactly why the parts are
 * business ids: the call sites' own guards (order state, stored
 * Stripe ids, ALREADY_SUBSCRIBED, find-or-create searches) remain
 * the long-term dedupe, and the key covers the retry window where
 * duplicate effects actually happen.
 */

const crypto = require('crypto');

function stripeIdempotencyKey(operation, ...parts) {
  const op =
    String(operation || 'op')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'op';
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((p) => (p == null ? '' : String(p))).join('\u001f'))
    .digest('hex');
  return `bp154_${op}_${digest}`;
}

module.exports = { stripeIdempotencyKey };
