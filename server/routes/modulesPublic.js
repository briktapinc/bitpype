'use strict';

/**
 * Public site-module JSON for in-page module-embed.js mounts
 * (token: `{workspaceId}_{random}`). /embed/module.html is a standalone viewer only.
 */

const express = require('express');
const domain = require('../domain');
const siteModules = require('../siteModules');
const { requireCaptcha, getCaptchaConfig } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const { assertWorkspaceExists } = require('../workspaceExists');

const router = express.Router();
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const bookLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const captcha = requireCaptcha();

function fail(res, e, status = 400) {
  const http =
    e.code === 'NOT_FOUND'
      ? 404
      : e.code === 'VALIDATION'
        ? e.status === 409
          ? 409
          : 400
        : typeof e.status === 'number'
          ? e.status
          : status;
  res.status(http).json({ ok: false, error: e.message || String(e), code: e.code });
}

/** Membership gate context sent by module-embed.js on module calls. */
function gateOpts(req) {
  return {
    memberSession: req.get('x-bitpype-member-session') || '',
    previewGrant: req.get('x-bitpype-preview-grant') || '',
    // The page slug rides a query param (keeps anonymous reads preflight-free);
    // the header form is still accepted for API consumers.
    pageSlug: (req.query && req.query.bpPage) || req.get('x-bitpype-page') || '',
  };
}

/**
 * Batch 21b: email the site owner about a visitor-created record
 * (booking / estimate request / member signup). Fire-and-forget after
 * the visitor's response — ownerNotify never throws, and a mail
 * problem must never surface to the visitor.
 */
function fireOwnerNotify(fnName, workspaceId, recordId) {
  if (!recordId) return;
  try {
    const ownerNotify = require('../ownerNotify');
    const fn = ownerNotify[fnName];
    if (typeof fn !== 'function') return;
    const p = fn(workspaceId, recordId);
    if (p && typeof p.catch === 'function') {
      p.catch((e) => console.warn('[modulesPublic] owner notify failed:', e && e.message));
    }
  } catch (e) {
    console.warn('[modulesPublic] owner notify failed:', e && e.message);
  }
}

async function workspaceFromReq(req) {
  const fromToken = siteModules.parseWorkspaceFromToken(req.params.token);
  const fromQuery = Number(
    (req.query && (req.query.w || req.query.workspaceId)) || (req.body && (req.body.w || req.body.workspaceId))
  );
  const workspaceId = fromToken || fromQuery;
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    const err = new Error('Could not resolve workspace for this module');
    err.code = 'INVALID';
    throw err;
  }
  await assertWorkspaceExists(workspaceId);
  return workspaceId;
}

router.get('/:token', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const slug = req.query.slug || req.query.item || null;
    const opts = gateOpts(req);
    const data = domain.withDb(workspaceId, (db) => {
      if (slug) return siteModules.getPublicModuleItem(db, req.params.token, slug, opts);
      return siteModules.getPublicModuleByToken(db, req.params.token, opts);
    });
    const captchaCfg = await getCaptchaConfig();
    res.json({ ok: true, data: { ...data, workspaceId, captcha: captchaCfg } });
  } catch (e) {
    fail(res, e);
  }
});

/** Available time slots for the bookings module (calendar day + service). */
router.get('/:token/slots', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const date = req.query.date || req.query.day;
    if (!date) {
      const err = new Error('date is required (YYYY-MM-DD)');
      err.code = 'VALIDATION';
      throw err;
    }
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.getPublicBookingSlots(
        db,
        req.params.token,
        {
          date,
          serviceId: req.query.serviceId || req.query.service_id || null,
          serviceSlug: req.query.service || req.query.serviceSlug || null,
        },
        gateOpts(req)
      )
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/** Shop checkout: mint a Stripe Checkout Session for a product (price read server-side). */
router.post('/:token/checkout', checkoutLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = await domain.withDb(workspaceId, (db) =>
      siteModules.createShopCheckoutByToken(
        db,
        req.params.token,
        {
          productId: body.productId || body.product_id || body.id,
          returnUrl: body.returnUrl || body.return_url || '',
        },
        gateOpts(req)
      )
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/** Shop order status for the post-checkout return page (session id is the credential). */
router.get('/:token/order-status', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const sessionId = req.query.session_id || req.query.sessionId;
    if (!sessionId) {
      const err = new Error('session_id is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const data = domain.withDb(workspaceId, (db) => {
      const order = siteModules.getShopOrderBySession(db, sessionId);
      if (!order) {
        const e = new Error('Order not found');
        e.code = 'NOT_FOUND';
        throw e;
      }
      return {
        orderId: order.id,
        status: order.status,
        productName: order.product_name,
        amountCents: order.amount_cents,
        currency: order.currency,
      };
    });
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/** Public appointment booking (creates pending or auto-confirmed appointment). */
router.post('/:token/book', bookLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.createPublicBookingByToken(db, req.params.token, body, gateOpts(req))
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
    fireOwnerNotify('notifyOwnerOfBooking', workspaceId, data && data.appointment && data.appointment.id);
  } catch (e) {
    fail(res, e);
  }
});

const estimateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

/** Public instant-estimate request (server recomputes the total; captures a LeadScout contact). */
router.post('/:token/estimate', estimateLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.createPublicEstimateRequestByToken(db, req.params.token, body, gateOpts(req))
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
    fireOwnerNotify('notifyOwnerOfEstimateRequest', workspaceId, data && data.request && data.request.id);
  } catch (e) {
    fail(res, e);
  }
});

/* ── Membership (site user accounts + page gating) ── */

const memberLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

/**
 * The authored body of a page on a members-gated site. The :token is the
 * MEMBERS module token; the body is returned only with a valid member
 * session (or owner preview grant) for that lead — otherwise a locked
 * 401 payload with the wall copy and zero body content.
 */
router.get('/:token/page/:slug', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const data = domain.withDb(workspaceId, (db) => {
      const embed = siteModules.membersEmbedByToken(db, req.params.token);
      return siteModules.getMemberPageBody(db, embed.lead_id, req.params.slug, gateOpts(req));
    });
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    if (e && e.code === 'MEMBER_LOCKED') {
      return res.status(401).json({ ok: false, error: e.message, code: e.code, gate: e.gate || null });
    }
    fail(res, e);
  }
});

/** Member signup (open mode logs the new member in; approval mode leaves them pending). */
router.post('/:token/members/signup', memberLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) => siteModules.publicMemberSignup(db, req.params.token, body));
    res.json({ ok: true, data: { ...data, workspaceId } });
    fireOwnerNotify('notifyOwnerOfMemberSignup', workspaceId, data && data.member && data.member.id);
  } catch (e) {
    fail(res, e);
  }
});

/** Member login — returns a session token the embed keeps in localStorage. */
router.post('/:token/members/login', memberLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) => siteModules.publicMemberLogin(db, req.params.token, body));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/** Member logout — deletes the session named by the session header. */
router.post('/:token/members/logout', memberLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const session = req.get('x-bitpype-member-session') || (req.body && req.body.session_token) || '';
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.publicMemberLogout(db, req.params.token, session)
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Forgot password — uniform response whether or not the email matches a
 * member (no account enumeration). The reset email goes out via the
 * platform mailer when a member exists; SMTP failures never surface.
 */
router.post('/:token/members/forgot', memberLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const prepared = domain.withDb(workspaceId, (db) => {
      const { embed, request } = siteModules.publicMemberForgot(db, req.params.token, body.email || '');
      if (!request) return null;
      const mail = siteModules.buildMemberResetMail(db, embed.lead_id, request.member, request.resetToken);
      return mail;
    });
    if (prepared) {
      try {
        const { sendPlatformMail } = require('../mailer');
        await sendPlatformMail(prepared);
      } catch {
        /* mail delivery problems must not leak account existence */
      }
    }
    res.json({
      ok: true,
      data: { sent: true, message: 'If an account exists for that email, a reset link is on its way.', workspaceId },
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Password reset — single-use token; a successful reset ends all sessions. */
router.post('/:token/members/reset', memberLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) => siteModules.publicMemberReset(db, req.params.token, body));
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Paid-tier join: Stripe Checkout on the SITE OWNER'S OWN Stripe
 * account. The caller must be a logged-in member (session header);
 * prices come from the tier row server-side. Mirrors shop checkout.
 */
router.post('/:token/members/checkout', checkoutLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = await domain.withDb(workspaceId, (db) =>
      siteModules.createMembershipCheckoutByToken(
        db,
        req.params.token,
        {
          tierId: body.tierId || body.tier_id || body.id,
          returnUrl: body.returnUrl || body.return_url || '',
        },
        gateOpts(req)
      )
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    if (e && e.code === 'MEMBER_LOCKED') {
      return res.status(401).json({ ok: false, error: e.message, code: e.code, gate: e.gate || null });
    }
    fail(res, e);
  }
});

/** Free-tier join: records the member's local membership (no Stripe). */
router.post('/:token/members/join', memberLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.joinFreeTierByToken(
        db,
        req.params.token,
        { tierId: body.tierId || body.tier_id || body.id },
        gateOpts(req)
      )
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    if (e && e.code === 'MEMBER_LOCKED') {
      return res.status(401).json({ ok: false, error: e.message, code: e.code, gate: e.gate || null });
    }
    fail(res, e);
  }
});

module.exports = router;
