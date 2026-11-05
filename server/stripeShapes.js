'use strict';

/**
 * Batch 145 (external review F17) — Stripe object-shape normalizers.
 *
 * The installed Stripe SDK defaults to API 2026-02-25.clover, where
 * the Invoice object no longer carries a top-level `subscription`
 * field: the reference moved to
 * `invoice.parent.subscription_details.subscription` (and the
 * subscription metadata that used to sit at
 * `invoice.subscription_details.metadata` moved under the same
 * parent). Webhook payloads follow each endpoint's configured API
 * version, so BOTH shapes occur in the wild. Every reader of an
 * invoice's subscription must go through these helpers instead of
 * reading `invoice.subscription` directly, so the next shape move
 * is a one-file fix.
 */

function stripeIdOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && value.id != null) return String(value.id);
  return '';
}

/** The subscription id an invoice belongs to ('' when unknown). */
function invoiceSubscriptionId(invoice) {
  if (!invoice || typeof invoice !== 'object') return '';
  const direct = invoice.subscription;
  if (direct != null && direct !== '') return stripeIdOf(direct);
  const parentDetails =
    invoice.parent && typeof invoice.parent === 'object' ? invoice.parent.subscription_details : null;
  return stripeIdOf(parentDetails && parentDetails.subscription);
}

/** The subscription_details block of an invoice (parent path first,
 *  legacy top-level as fallback), or null. */
function invoiceSubscriptionDetails(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const parentDetails =
    invoice.parent && typeof invoice.parent === 'object' ? invoice.parent.subscription_details : null;
  if (parentDetails && typeof parentDetails === 'object') return parentDetails;
  if (invoice.subscription_details && typeof invoice.subscription_details === 'object') {
    return invoice.subscription_details;
  }
  return null;
}

/** The subscription metadata of an invoice (user_id / plan stamps). */
function invoiceSubscriptionMetadata(invoice) {
  const details = invoiceSubscriptionDetails(invoice);
  return details && details.metadata && typeof details.metadata === 'object' ? details.metadata : null;
}

module.exports = { stripeIdOf, invoiceSubscriptionId, invoiceSubscriptionDetails, invoiceSubscriptionMetadata };
