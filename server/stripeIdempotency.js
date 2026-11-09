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

/**
 * Batch 168 (external review F06): attempt-scoped keys for
 * REPEATABLE intentional actions. The deterministic key above is
 * right for find-or-create / convergent operations (create the
 * customer, the product, the per-order checkout session, a metadata
 * sync): the same operation retried IS the same operation. It is
 * wrong for actions a user legitimately performs more than once
 * against the same resource — cancel → resume → cancel, A→B→A plan
 * changes, a second credit-pack purchase, a second same-amount
 * refund: the deterministic key made Stripe replay the FIRST
 * action's response, so the second action silently never happened
 * while the UI reported success from the replayed payload.
 *
 * stripeAttemptKey keeps the business-id parts (correlation) and
 * adds a per-INVOCATION attempt id. Each of these call sites makes
 * exactly one Stripe call per invocation (no internal retry loop),
 * and an HTTP-level retry is a new user action — so per-invocation
 * uniqueness preserves real retry safety (a failed call changed
 * nothing and the next click executes for real) while distinct
 * actions always execute.
 */
function stripeAttemptKey(operation, ...parts) {
  return stripeIdempotencyKey(operation, ...parts, `attempt:${crypto.randomUUID()}`);
}

module.exports = { stripeIdempotencyKey, stripeAttemptKey };
