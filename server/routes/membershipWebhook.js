'use strict';

/**
 * Stripe webhooks for site memberships (Batch 17).
 *
 * URL: POST /api/v1/membership/webhook/:workspaceId — every site owner
 * points THEIR OWN Stripe account's webhook at this URL. A workspace
 * can hold many owners' keys, so the lead is resolved from the event's
 * own metadata / local subscription records first, and the payload is
 * then verified against THAT lead's webhook secret — nothing is
 * applied before verification passes. Events whose lead cannot be
 * resolved are rejected and logged. Mounted in server.js with
 * express.raw BEFORE the JSON parser, like the shop webhook.
 * Application is idempotent, so Stripe retries are safe.
 */

const express = require('express');
const domain = require('../domain');
const siteModules = require('../siteModules');
const membershipStripe = require('../membershipStripe');
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
  if (!peek || typeof peek !== 'object') {
    return res.status(400).json({ ok: false, error: 'Malformed webhook payload' });
  }
  let event;
  try {
    event = domain.withDb(workspaceId, (db) => {
      const leadId = membershipStripe.resolveLeadForEvent(db, peek);
      if (!leadId) {
        const e = new Error('Could not resolve the site for this membership event');
        e.code = 'MEMBERSHIP_LEAD_UNRESOLVED';
        throw e;
      }
      return membershipStripe.constructEventForLead(db, leadId, rawBody, req.headers['stripe-signature']);
    });
  } catch (e) {
    if (e && e.code === 'MEMBERSHIP_STRIPE_NOT_CONFIGURED') {
      return res.status(409).json({ ok: false, error: e.message, code: e.code });
    }
    if (e && e.code === 'MEMBERSHIP_LEAD_UNRESOLVED') {
      console.error('[membership-webhook] unresolved lead', workspaceId, peek && peek.type);
      return res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
    // Signature verification failure (or malformed payload): tell Stripe
    // not to retry a request we can never accept.
    return res.status(400).json({ ok: false, error: 'Webhook signature verification failed' });
  }
  try {
    const result = domain.withDb(workspaceId, (db) => siteModules.applyMembershipStripeEvent(db, event));
    return res.json({ ok: true, received: true, ...result });
  } catch (e) {
    // 500 so Stripe retries — the event itself is verified and valid.
    console.error('[membership-webhook] apply failed', workspaceId, event && event.type, e && e.message);
    return res.status(500).json({ ok: false, error: 'Event handling failed' });
  }
});

module.exports = router;
