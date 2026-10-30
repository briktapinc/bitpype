'use strict';

/**
 * Partner-facing API (Batch 80) — the signed-in partner's own views:
 * earnings summary (balance, per-payment history, payout history) and
 * their purchase-approval requests. Session-authenticated; a
 * non-partner session gets a coded 403. Data is strictly the
 * partner's own (keyed on the session user id).
 */

const express = require('express');
const partners = require('../partners');
const { requireAuth } = require('../middleware');
const apiErrors = require('../apiErrors');

const router = express.Router();
router.use(requireAuth);

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, e, status = 400) {
  apiErrors.sendError(res, e, status, { area: 'partners' });
}

async function requirePartner(req, res, next) {
  try {
    if (await partners.isPartnerUser(req.session.userId)) return next();
    return res.status(403).json({
      ok: false,
      error: 'NOT_A_PARTNER',
      code: 'NOT_A_PARTNER',
      message: 'This area is for BitPype partner accounts.',
    });
  } catch (e) {
    return next(e);
  }
}

router.get('/me', requirePartner, async (req, res) => {
  try {
    const summary = await partners.earningsSummary(req.session.userId);
    ok(res, {
      ...summary,
      terms: {
        ratePercent: summary.ratePercent,
        thresholdCents: summary.thresholdCents,
        payoutCycle: 'monthly',
        taxes:
          'Payouts are gross — no tax is withheld. You are responsible for your own taxes on partner earnings.',
        support: 'You support your own customers day to day; the BitPype team backs you up on platform issues.',
        catalog: 'Partners sell the standard BitPype plans at the standard prices.',
        purchases:
          'Anything that costs money (domains, phone numbers, credits, deployments) is double-checked and approved by the BitPype team before it runs.',
      },
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/approvals', requirePartner, async (req, res) => {
  try {
    ok(res, {
      approvals: await partners.listApprovals({ requestedBy: req.session.userId }),
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

module.exports = router;
