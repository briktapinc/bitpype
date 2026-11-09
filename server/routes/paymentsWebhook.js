'use strict';

/**
 * Batch 129 — THE one tenant-payments webhook pipeline.
 *
 * URL: POST /api/v1/payments/webhook/:workspaceId (canonical). The
 * two legacy URLs — /api/v1/shop/webhook/:workspaceId and
 * /api/v1/membership/webhook/:workspaceId — mount THIS SAME router
 * (their route files are thin re-exports): site owners configured
 * those URLs in their own Stripe dashboards before 129, and a URL
 * an owner must re-configure is a broken promise, so all three run
 * one identical handler forever.
 *
 * One handler for every tenant event because there is now ONE
 * payments config per business: the lead is resolved from the
 * event's own metadata / local records (peeked values only SELECT
 * the verification candidates — nothing applies before a signature
 * check passes), then the payload is verified against EVERY secret
 * the business has on file — unified config, both legacy key
 * stores, then the workspace secret (paymentsConfig.
 * constructEventAny). That cross-store candidate list is what keeps
 * pre-129 subscriptions billing undisturbed: an event signed by
 * the retired membership store's secret still verifies, and the
 * unified dispatcher (siteModules.applyTenantStripeEvent) routes
 * it to the membership apply exactly as the old pipeline did.
 * Application is idempotent on both pipelines, so Stripe retries
 * and replays are no-ops. Mounted in server.js with express.raw
 * BEFORE the JSON parser, like the billing webhook. The platform's
 * OWN subscription billing webhook (/api/v1/billing/webhook) is a
 * different account and pipeline and is NOT part of this handler.
 */

const express = require('express');
const domain = require('../domain');
const siteModules = require('../siteModules');
const shopStripe = require('../shopStripe');
const paymentsConfig = require('../paymentsConfig');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();

function isMembershipShaped(peek) {
  if (!peek || typeof peek !== 'object') return false;
  const type = String(peek.type || '');
  const meta = (peek.data && peek.data.object && peek.data.object.metadata) || {};
  return !!meta.bitpype_member_id || type.startsWith('customer.subscription.') || type.startsWith('invoice.');
}

router.post('/:workspaceId', async (req, res) => {
  const workspaceId = Number(req.params.workspaceId);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid workspace id' });
  }
  try {
    await assertWorkspaceExists(workspaceId);
  } catch {
    return res.status(404).json({ ok: false, error: 'Workspace not found' });
  }
  return handlePaymentsWebhook(req, res, workspaceId);
});

/* Batch 168 (external review F14): the standalone installer
 * registers the BARE path (no workspace id — a clone has exactly
 * one workspace and its Stripe dashboard was pointed at the bare
 * URL). In single-site mode the bare path resolves the clone's
 * sole workspace and runs the same handler; on the platform the
 * bare path stays a 404 (there is no default workspace, and
 * guessing one would be a cross-tenant hole). Signature
 * verification is unchanged — resolution only SELECTS the
 * workspace whose secrets verify the event. */
router.post('/', async (req, res) => {
  try {
    if (!require('../singleSite').isSingleSite()) {
      return res.status(404).json({ ok: false, error: 'Workspace not found' });
    }
    const rows = await require('../db').query('SELECT id FROM workspaces ORDER BY id ASC LIMIT 1');
    const workspaceId = rows && rows[0] ? Number(rows[0].id) : 0;
    if (!workspaceId) return res.status(404).json({ ok: false, error: 'Workspace not found' });
    return handlePaymentsWebhook(req, res, workspaceId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Webhook resolver failed' });
  }
});

async function handlePaymentsWebhook(req, res, workspaceId) {
  const rawBody = req.body;
  let peek = null;
  try {
    peek = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  } catch {
    peek = null;
  }
  let event;
  let keySource = '';
  try {
    const verified = domain.withDb(workspaceId, (db) => {
      const leadId = peek ? paymentsConfig.resolveLeadForEvent(db, peek) : null;
      if (leadId) {
        return paymentsConfig.constructEventAny(db, leadId, rawBody, req.headers['stripe-signature']);
      }
      if (isMembershipShaped(peek)) {
        // Preserve the legacy membership behavior: an event we
        // cannot attribute to a site is rejected, never guessed at.
        const e = new Error('Could not resolve the site for this membership event');
        e.code = 'MEMBERSHIP_LEAD_UNRESOLVED';
        throw e;
      }
      // Shop-shaped with no resolvable lead: the workspace secret is
      // the last candidate (the long-standing shop behavior).
      return { event: shopStripe.constructEvent(db, rawBody, req.headers['stripe-signature']), source: 'workspace' };
    });
    event = verified.event;
    keySource = verified.source;
  } catch (e) {
    if (e && (e.code === 'PAYMENTS_NOT_CONFIGURED' || e.code === 'SHOP_STRIPE_NOT_CONFIGURED')) {
      return res.status(409).json({ ok: false, error: e.message, code: e.code });
    }
    if (e && e.code === 'MEMBERSHIP_LEAD_UNRESOLVED') {
      console.error('[payments-webhook] unresolved lead', workspaceId, peek && peek.type);
      return res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
    // Signature verification failure (or malformed payload): tell Stripe
    // not to retry a request we can never accept.
    return res.status(400).json({ ok: false, error: 'Webhook signature verification failed' });
  }
  // Owner-notification snapshots (Batch 21b semantics, both legacy
  // pipelines preserved): the shop email fires only on the
  // pending → paid transition; the membership email only when
  // checkout completion CREATES the subscription row.
  let priorOrderStatus = null;
  if (event && event.type && event.type.startsWith('checkout.session.')) {
    const obj = (event.data && event.data.object) || {};
    try {
      priorOrderStatus = domain.withDb(workspaceId, (db) => {
        const order = siteModules.getShopOrderBySession(db, String(obj.id || ''));
        return order ? order.status : null;
      });
    } catch {
      priorOrderStatus = null;
    }
  }
  let subIdsBefore = null;
  if (event && event.type === 'checkout.session.completed') {
    const meta = (event.data && event.data.object && event.data.object.metadata) || {};
    const leadId = Number(meta.bitpype_lead_id);
    const memberId = Number(meta.bitpype_member_id);
    if (leadId && memberId) {
      try {
        subIdsBefore = domain.withDb(workspaceId, (db) =>
          siteModules.listMemberSubscriptions(db, leadId, { memberId }).map((s) => s.id)
        );
      } catch {
        subIdsBefore = null;
      }
    }
  }
  try {
    const result = domain.withDb(workspaceId, (db) => siteModules.applyTenantStripeEvent(db, event));
    const response = res.json({ ok: true, received: true, key_source: keySource, ...result });
    if (
      result &&
      result.pipeline === 'shop' &&
      result.matched &&
      result.status === 'paid' &&
      result.orderId &&
      priorOrderStatus !== 'paid'
    ) {
      try {
        const ownerNotify = require('../ownerNotify');
        ownerNotify
          .notifyOwnerOfShopOrder(workspaceId, result.orderId)
          .catch((e) => console.warn('[payments-webhook] owner notify failed:', e && e.message));
      } catch (e) {
        console.warn('[payments-webhook] owner notify failed:', e && e.message);
      }
    }
    if (
      result &&
      result.pipeline === 'membership' &&
      subIdsBefore &&
      result.matched &&
      result.subscriptionId &&
      !subIdsBefore.includes(result.subscriptionId)
    ) {
      try {
        const ownerNotify = require('../ownerNotify');
        ownerNotify
          .notifyOwnerOfMembership(workspaceId, result.subscriptionId)
          .catch((e) => console.warn('[payments-webhook] owner notify failed:', e && e.message));
      } catch (e) {
        console.warn('[payments-webhook] owner notify failed:', e && e.message);
      }
    }
    return response;
  } catch (e) {
    // 500 so Stripe retries — the event itself is verified and valid.
    console.error('[payments-webhook] apply failed', workspaceId, event && event.type, e && e.message);
    return res.status(500).json({ ok: false, error: 'Event handling failed' });
  }
}

module.exports = router;
