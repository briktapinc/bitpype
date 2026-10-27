'use strict';

/**
 * Stripe webhooks for tenant Shop checkouts.
 *
 * URL: POST /api/v1/shop/webhook/:workspaceId — each workspace's orders
 * live in its own tenant DB. Two key layers can sign these events
 * (Batch 19): the SITE OWNER's own Stripe account (their keys, saved
 * in the portal — Shop → Payments) and the workspace account
 * (Settings → Shop payments). The lead is resolved from the event's
 * own metadata / local order records first, and the payload is then
 * verified against that lead's secret, falling back to the workspace
 * secret — nothing is applied until a signature check passes against
 * one of our secrets. Mounted in server.js with express.raw BEFORE
 * the JSON parser, like the billing webhook. Stripe retries any
 * non-2xx, and order application is idempotent, so redeliveries are
 * safe.
 */

const express = require('express');
const domain = require('../domain');
const siteModules = require('../siteModules');
const shopStripe = require('../shopStripe');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();

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
    const verified = domain.withDb(workspaceId, (db) =>
      shopStripe.constructEventForShop(db, rawBody, req.headers['stripe-signature'], peek)
    );
    event = verified.event;
    keySource = verified.source;
  } catch (e) {
    if (e && e.code === 'SHOP_STRIPE_NOT_CONFIGURED') {
      return res.status(409).json({ ok: false, error: e.message, code: e.code });
    }
    // Signature verification failure (or malformed payload): tell Stripe
    // not to retry a request we can never accept.
    return res.status(400).json({ ok: false, error: 'Webhook signature verification failed' });
  }
  // Batch 21b: remember the order's pre-apply status so the owner
  // email fires only on the pending → paid transition (Stripe
  // redeliveries and repeat events stay silent).
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
  try {
    const result = domain.withDb(workspaceId, (db) => siteModules.applyShopStripeEvent(db, event));
    const response = res.json({ ok: true, received: true, key_source: keySource, ...result });
    if (result && result.matched && result.status === 'paid' && result.orderId && priorOrderStatus !== 'paid') {
      try {
        const ownerNotify = require('../ownerNotify');
        ownerNotify
          .notifyOwnerOfShopOrder(workspaceId, result.orderId)
          .catch((e) => console.warn('[shop-webhook] owner notify failed:', e && e.message));
      } catch (e) {
        console.warn('[shop-webhook] owner notify failed:', e && e.message);
      }
    }
    return response;
  } catch (e) {
    // 500 so Stripe retries — the event itself is verified and valid.
    console.error('[shop-webhook] apply failed', workspaceId, event && event.type, e && e.message);
    return res.status(500).json({ ok: false, error: 'Event handling failed' });
  }
});

module.exports = router;
