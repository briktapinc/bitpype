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
const apiErrors = require('../apiErrors');

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
  apiErrors.sendError(res, e, http, { area: 'modulesPublic' });
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

/**
 * Batch 25: SMS opt-in for the module forms that collect a phone
 * (bookings, instant estimate). Fire-and-forget after the visitor's
 * response, same pattern as fireOwnerNotify — the opt-in handler
 * never throws, records the consent on the LeadScout contact, and
 * sends the welcome text when SMS is configured.
 */
function fireSmsOptIn(workspaceId, args) {
  if (!args || !args.phone) return;
  try {
    const smsOptIn = require('../smsOptIn');
    if (!smsOptIn.truthyConsent(args.consent)) return;
    const p = smsOptIn.handleSmsOptInForWorkspace(workspaceId, args);
    if (p && typeof p.catch === 'function') {
      p.catch((e) => console.warn('[modulesPublic] sms opt-in failed:', e && e.message));
    }
  } catch (e) {
    console.warn('[modulesPublic] sms opt-in failed:', e && e.message);
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

/**
 * QR Code public image (Batch 126): the rendered code behind the QR
 * module's own token. Resolution is serve-time (renamed pages follow,
 * vanished targets 404), and the id always resolves inside the token's
 * lead — a foreign code id is a 404, never another site's code.
 */
router.get('/:token/qrcode/:file', readLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    // The id/format parse is lenient here on purpose: resolution (and
    // its NOT_FOUND for unparseable, foreign, draft or dormant codes)
    // belongs to the service, after the workspace gate — the same
    // shape as the /:token/page/:slug route below.
    const m = /^(\d+)\.(png|svg)$/.exec(String(req.params.file || ''));
    const resolved = domain.withDb(workspaceId, (db) =>
      siteModules.resolvePublicQrCode(db, req.params.token, m ? Number(m[1]) : 0)
    );
    const rendered = await siteModules.renderQrCodeImage(resolved.payload, resolved.code, {
      format: m ? m[2] : 'png',
    });
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', rendered.contentType);
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    res.send(rendered.body);
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
          variantId: body.variantId || body.variant_id || undefined,
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

/**
 * Batch 128 — cart checkout for the Checkout module: the token is the
 * CHECKOUT module's; the lines ({source, itemId, quantity,
 * variantId?}) are re-priced from the source modules' rows
 * server-side and charged as one session on the lead's own shop
 * Stripe configuration.
 */
router.post('/:token/checkout-cart', checkoutLimit, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = await domain.withDb(workspaceId, (db) =>
      siteModules.createCartCheckoutByToken(
        db,
        req.params.token,
        {
          items: body.items || body.lines || [],
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
      // Batch 128: the order must belong to the lead whose module
      // token is asking. The session id stays the credential, but a
      // session from another business's shop no longer resolves
      // under this site's token — strict lead isolation on reads.
      const embed = siteModules.getEmbedRowByToken(db, req.params.token);
      if (!order || !embed || Number(order.lead_id) !== Number(embed.lead_id)) {
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
        // Batch 128: the recorded lines ride along (name, variant,
        // source, photo, qty, line total) so the return/success
        // state can show exactly what was bought — a purchased
        // gallery photo's line is the buyer's download delivery.
        items: siteModules.listShopOrderItems(db, order.id).map((it) => ({
          name: it.product_name,
          variantLabel: it.variant_label || '',
          source: it.source_module || 'ecommerce',
          imageUrl: it.image_url || '',
          quantity: Number(it.quantity) || 1,
          lineTotalCents: Number(it.line_total_cents) || 0,
          currency: it.currency || order.currency,
        })),
      };
    });
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Site Rentals (Batch 26): settle pending per-lead rental charges for
 * the workspace after a capture that may have created one (booking /
 * estimate). Fire-and-forget — soft billing never blocks a visitor.
 */
function fireRentalSettle(workspaceId) {
  try {
    const p = require('../rentals').settlePendingCharges(workspaceId);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* rentals unavailable */
  }
}

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
    fireRentalSettle(workspaceId);
    fireSmsOptIn(workspaceId, {
      leadId: data && data.embed && data.embed.lead_id,
      name: body.customer_name || body.name || '',
      email: body.customer_email || body.email || '',
      phone: body.customer_phone || body.phone || '',
      consent: body.sms_optin_consent,
      source: 'booking',
    });
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
    fireRentalSettle(workspaceId);
    fireSmsOptIn(workspaceId, {
      leadId: data && data.embed && data.embed.lead_id,
      name: body.name || '',
      email: body.email || '',
      phone: body.phone || '',
      consent: body.sms_optin_consent,
      source: 'estimate',
    });
  } catch (e) {
    fail(res, e);
  }
});

const datatableSubmitLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

/**
 * Data Tables (Batch 88): the module's only public write path — a
 * visitor submission into the site's table. Same protections as the
 * booking / estimate posts above (per-IP rate limit + Turnstile);
 * whether the row lands pending or live is the instance's
 * submit_mode, decided server-side in siteModules.
 */
router.post('/:token/submit', datatableSubmitLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) =>
      siteModules.createPublicDataTableSubmissionByToken(
        db,
        req.params.token,
        { values: body.values != null ? body.values : body },
        gateOpts(req)
      )
    );
    res.json({ ok: true, data: { ...data, workspaceId } });
  } catch (e) {
    if (e && e.code === 'MEMBER_LOCKED') {
      return res.status(401).json({ ok: false, error: e.message, code: e.code, gate: e.gate || null });
    }
    fail(res, e, e.status || 400);
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

/**
 * Batch 118 — Newsletter signup. The response is deliberately
 * state-blind (new / duplicate / previously-unsubscribed all read the
 * same) so the endpoint cannot probe who is on a client's list; only a
 * genuinely new subscriber captures into LeadScout and emails the
 * owner (inside subscribeByToken / the notify below).
 */
router.post('/:token/newsletter/subscribe', bookLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    const data = domain.withDb(workspaceId, (db) =>
      require('../newsletter').subscribeByToken(db, req.params.token, body)
    );
    res.json({ ok: true, data: { message: data.message, workspaceId } });
    if (data.added) {
      fireOwnerNotify('notifyOwnerOfNewsletterSignup', workspaceId, data.subscriberId);
    }
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Batch 125 — Photo Capture submission. The photo arrives as a
 * base64 data URL and is stored through the SAME module-asset
 * pipeline the portal's image uploads use (content sniff, ~5 MB cap,
 * optimization, site export folder) — never a parallel store. The
 * pipeline call is async and opens its own db session, so the flow
 * is: resolve the embed (gates: archived / suspended / member) →
 * store the photo → record the submission (LeadScout capture rides
 * inside createPhotoSubmission). The visitor's response is
 * state-blind: the same thanks whatever moderation later decides.
 */
router.post('/:token/photocapture', bookLimit, captcha, async (req, res) => {
  try {
    const workspaceId = await workspaceFromReq(req);
    const body = req.body || {};
    // ONE tenant-db touch for the whole submission (the public
    // routes' house shape — the workspace-guard regression suite
    // pins exactly one): the async withDb callback resolves the
    // embed, stores the photo through the module-asset pipeline
    // (async — image optimization cannot run inside a sync db
    // section), then records the submission on the same handle.
    const data = await domain.withDb(workspaceId, async (db) => {
      const image = String(body.image || body.imageData || body.data || '');
      if (!image.trim()) {
        const err = new Error('Please choose a photo to send');
        err.code = 'VALIDATION';
        throw err;
      }
      const payload = siteModules.getPublicModuleByToken(db, req.params.token, gateOpts(req));
      if (payload.module_type !== 'photocapture') {
        const err = new Error('Photo Capture module not found');
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
      }
      if (payload.locked) {
        const err = new Error('Sign in to send a photo');
        err.code = 'MEMBER_LOCKED';
        err.status = 403;
        throw err;
      }
      // Batch 132: validate the visitor's fields BEFORE the photo is
      // stored. The pipeline writes the file first in the flow below,
      // so validating only inside createPhotoSubmission (after
      // storage) left an orphaned file in the site's export for
      // every refused submission. The rules live in ONE place —
      // siteModules.validatePhotoSubmissionFields, the same checks
      // createPhotoSubmission enforces for its other callers.
      siteModules.validatePhotoSubmissionFields(body);
      let stored;
      try {
        stored = await require('../portalSiteEdits').applyModuleAssetUpload(
          workspaceId,
          Number(payload.embed.lead_id),
          { data: image, mimeType: body.mimeType || body.mime_type || '' }
        );
      } catch (e) {
        const err = new Error(e.message || 'That photo could not be accepted');
        err.code = 'VALIDATION';
        throw err;
      }
      return siteModules.createPublicPhotoSubmissionByToken(
        db,
        req.params.token,
        {
          name: body.name,
          email: body.email,
          phone: body.phone,
          message: body.message,
          image_url: stored.publicUrl || stored.src || '',
          image_src: stored.src || '',
          page_slug: body.pageSlug || body.page_slug || gateOpts(req).pageSlug || '',
        },
        gateOpts(req)
      );
    });
    res.json({ ok: true, data: { message: data.message, workspaceId } });
    fireOwnerNotify('notifyOwnerOfPhotoSubmission', workspaceId, data.submission && data.submission.id);
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
