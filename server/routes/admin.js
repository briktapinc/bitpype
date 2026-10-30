'use strict';

const express = require('express');
const admin = require('../admin');
const platform = require('../platform');
const { requireAuth, requireSuperAdmin } = require('../middleware');
const apiErrors = require('../apiErrors');

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, e, status = 400) {
  const code = e.code || status;
  const http = typeof code === 'number' ? code : e.code === 'NOT_FOUND' ? 404 : status;
  apiErrors.sendError(res, e, http, { area: 'admin' });
}

router.get('/overview', async (req, res) => {
  try {
    ok(res, await admin.overview());
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/audit', async (req, res) => {
  try {
    ok(res, { rows: await platform.listAudit({ limit: req.query.limit }) });
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Users ----------
router.get('/users', async (req, res) => {
  try {
    ok(res, { users: await admin.listUsers(req.query) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/users/:id', async (req, res) => {
  try {
    const data = await admin.getUser(Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/users', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email || !b.password) return fail(res, new Error('email and password required'));
    const created = await admin.createUser(b);
    await platform.audit(req.session.userId, 'user.create', `userId=${created.userId} email=${b.email}`);
    ok(res, created);
  } catch (e) {
    fail(res, e, e.code === 'EMAIL_IN_USE' ? 409 : 400);
  }
});
router.patch('/users/:id', async (req, res) => {
  try {
    const data = await admin.updateUser(Number(req.params.id), req.body || {}, {
      actorUserId: req.session.userId,
    });
    await platform.audit(
      req.session.userId,
      'user.update',
      `userId=${req.params.id} ${JSON.stringify(Object.keys(req.body || {}))}`
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'EMAIL_IN_USE' ? 409 : 400);
  }
});
router.delete('/users/:id', async (req, res) => {
  try {
    const data = await admin.deleteUser(Number(req.params.id), {
      actorUserId: req.session.userId,
    });
    await platform.audit(req.session.userId, 'user.delete', `userId=${req.params.id}`);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- Creator Partners (Batch 80) ----------
// Partner accounts are created through the Users routes above with
// accountType 'partner' (admin-created only). Here: balances across
// partners, record-payout (the app records it; money moves outside),
// and the purchase-approval queue.
router.get('/partners', async (req, res) => {
  try {
    ok(res, { partners: await require('../partners').listPartners() });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/partners/:userId/earnings', async (req, res) => {
  try {
    ok(res, await require('../partners').earningsSummary(Number(req.params.userId)));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/partners/:userId/payouts', async (req, res) => {
  try {
    const b = req.body || {};
    const data = await require('../partners').recordPayout({
      partnerUserId: Number(req.params.userId),
      amountCents: b.amountCents != null ? Number(b.amountCents) : null,
      method: b.method || '',
      note: b.note || '',
      paidBy: req.session.userId,
    });
    await platform.audit(
      req.session.userId,
      'partner.payout',
      `partnerUserId=${req.params.userId} amountCents=${data.amountCents}`
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.status || 400);
  }
});
router.get('/partner-approvals', async (req, res) => {
  try {
    ok(res, {
      approvals: await require('../partners').listApprovals({ status: req.query.status || null }),
    });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/partner-approvals/:id/decide', async (req, res) => {
  try {
    const data = await require('../partners').decideApproval({
      approvalId: Number(req.params.id),
      adminUserId: req.session.userId,
      approve: !!(req.body && req.body.approve),
    });
    await platform.audit(
      req.session.userId,
      'partner.approval_decide',
      `approvalId=${req.params.id} status=${data.status} kind=${data.actionKind}`
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.status || 400);
  }
});

// Batch 40 — MFA reset: clears a staff member's TOTP secret + enabled
// flag + recovery codes. Staff TOTP is required, so the user simply
// re-enrolls inline at their next login (no lockout state exists).
router.post('/users/:id/mfa/reset', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = await admin.getUser(id);
    if (!target) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    await require('../mfa').clearMfa('staff', id);
    await platform.audit(req.session.userId, 'user.mfa_reset', `userId=${id}`);
    ok(res, { reset: true });
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Client portal users (Batch 29: user types + nav access) ----------
// Portal users are end customers (client_portal_users), distinct from the
// staff users above. Admin sets each one's type ('owner' | 'renter') and
// optional per-tab overrides; the portal API enforces the result.
router.get('/portal-users', async (req, res) => {
  try {
    ok(res, await require('../clientPortal').listPortalUsers(req.query));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.patch('/portal-users/:id', async (req, res) => {
  try {
    const data = await require('../clientPortal').updatePortalUserAccess(
      Number(req.params.id),
      req.body || {}
    );
    await platform.audit(
      req.session.userId,
      'portal_user.access',
      `portalUserId=${req.params.id} ${JSON.stringify(req.body || {})}`
    );
    ok(res, { user: data });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Batch 45 — super-admin delete of a client portal user (this router is
// requireSuperAdmin-gated end to end). Mirrors the staff-user delete:
// engine removes the row (TOTP material lives on it; sessions die on
// their next requireClient read) and the action is platform-audited.
router.delete('/portal-users/:id', async (req, res) => {
  try {
    const data = await require('../clientPortal').deletePortalUser(Number(req.params.id));
    await platform.audit(req.session.userId, 'portal_user.delete', `portalUserId=${req.params.id} email=${data.email}`);
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Batch 40 — MFA reset for a portal client who lost their authenticator
// and recovery codes (portal TOTP is opt-in; clearing returns them to
// password-only sign-in until they choose to re-enable it).
router.post('/portal-users/:id/mfa/reset', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = await require('../clientPortal').findById(id);
    if (!target) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    await require('../mfa').clearMfa('portal', id);
    await platform.audit(req.session.userId, 'portal_user.mfa_reset', `portalUserId=${id}`);
    ok(res, { reset: true });
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Portal access type defaults (Batch 29) ----------
// The factory defaults ship in code (server/portalTabs.js); what admin
// saves here is stored as the `portal_access.type_defaults` platform
// setting and becomes the live default tab/module set per user type.
// Per-user overrides (PATCH /portal-users/:id) still win per item.
router.get('/portal-access-defaults', async (req, res) => {
  try {
    ok(res, await require('../clientPortal').getPortalAccessDefaults());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/portal-access-defaults', async (req, res) => {
  try {
    const data = await require('../clientPortal').setPortalAccessDefaults(req.body || {});
    await platform.audit(
      req.session.userId,
      'portal_access.defaults',
      JSON.stringify((req.body || {}).renter || {})
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, 400);
  }
});

// ---------- Workspaces ----------
router.get('/workspaces', async (req, res) => {
  try {
    ok(res, { workspaces: await admin.listWorkspaces(req.query) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.getWorkspace(Number(req.params.id));
    if (!data) return fail(res, Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }), 404);
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/workspaces', async (req, res) => {
  try {
    const created = await admin.createWorkspace(req.body || {});
    await platform.audit(req.session.userId, 'workspace.create', `workspaceId=${created.workspaceId}`);
    ok(res, created);
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.updateWorkspace(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'workspace.update', `workspaceId=${req.params.id}`);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/workspaces/:id', async (req, res) => {
  try {
    const data = await admin.deleteWorkspace(Number(req.params.id));
    await platform.audit(req.session.userId, 'workspace.delete', `workspaceId=${req.params.id}`);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.post('/workspaces/:id/members', async (req, res) => {
  try {
    const b = req.body || {};
    const data = await admin.addMember(Number(req.params.id), Number(b.userId), b.role || 'member');
    await platform.audit(req.session.userId, 'workspace.member.add', `ws=${req.params.id} user=${b.userId}`);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/workspaces/:id/members/:userId', async (req, res) => {
  try {
    const data = await admin.removeMember(Number(req.params.id), Number(req.params.userId));
    await platform.audit(
      req.session.userId,
      'workspace.member.remove',
      `ws=${req.params.id} user=${req.params.userId}`
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- Platform settings ----------
router.get('/settings', async (req, res) => {
  try {
    const settings = await platform.getAllPlatformSettings({ redact: true });
    // Batch 47: captcha status rides along so Admin → Settings can show
    // whether Turnstile is actually configured/enforcing instead of an
    // admin having to assume it. Status only — never key material.
    let captcha = null;
    try {
      captcha = await require('../captcha').getCaptchaStatus();
    } catch {
      captcha = null; /* the settings page must not die on a status read */
    }
    ok(res, {
      settings,
      captcha,
      defs: platform.PLATFORM_SETTING_DEFS.map((d) => ({
        key: d.key,
        group: d.group,
        label: d.label,
        secret: !!(d.secret || platform.PLATFORM_SECRET_KEYS.includes(d.key)),
      })),
    });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/settings/adsense-state', async (req, res) => {
  try {
    ok(res, await require('../adsense').adminState());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/settings', async (req, res) => {
  try {
    const result = await platform.setPlatformSettingsBatch(
      req.body && req.body.settings ? req.body.settings : req.body
    );
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(req.session.userId, 'platform.settings', `updated=${(result.updated || []).join(',')}`);
    ok(res, result);
  } catch (e) {
    fail(res, e);
  }
});
router.put('/settings/secret', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return fail(res, new Error('key required'));
    if (
      !platform.PLATFORM_SECRET_KEYS.includes(key) &&
      !(platform.PLATFORM_SETTING_DEFS.find((d) => d.key === key) || {}).secret
    ) {
      return fail(res, new Error('Not a secret key'));
    }
    if (!value || value === '***') return fail(res, new Error('value required'));
    await platform.setPlatformSetting(key, value);
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(req.session.userId, 'platform.secret', `key=${key}`);
    ok(res, { key, set: true });
  } catch (e) {
    fail(res, e);
  }
});
// ---------- Pricing control (Batch 24) ----------
// Amounts in, Stripe Products/Prices managed: see server/pricingAdmin.js.
router.get('/settings/pricing', async (req, res) => {
  try {
    ok(res, await require('../pricingAdmin').getPricingState());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/settings/pricing', async (req, res) => {
  try {
    const result = await require('../pricingAdmin').updatePricing(
      req.body && req.body.amounts ? req.body.amounts : req.body
    );
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(
      req.session.userId,
      'platform.pricing',
      `mode=${result.mode} updated=${result.updated.map((u) => `${u.id}=$${u.amountUsd}`).join(',') || 'none'} unchanged=${(result.unchanged || []).join(',') || 'none'}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, e.code === 'STRIPE_NOT_CONFIGURED' ? 503 : e.code === 'INVALID_AMOUNT' ? 400 : 502);
  }
});

// ---------- Package contents (Batch 57) ----------
// Plan names / taglines / feature bullets / entitlements, editable like
// the amounts above: see server/planContents.js. Contents changes take
// effect for everyone on the plan immediately (entitlements included).
router.get('/settings/plans-contents', async (req, res) => {
  try {
    ok(res, await require('../planContents').getPlanContentsState());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/settings/plans-contents', async (req, res) => {
  try {
    const result = await require('../planContents').updatePlanContents(
      req.body && req.body.contents ? req.body.contents : req.body
    );
    // Batch 63: opt-in subscriber notice — only when the panel's
    // "Email this change to current subscribers" checkbox was checked,
    // and only for plans whose contents actually changed (updated or
    // reset). Best-effort per plan; failures surface in the response,
    // never as a failed save.
    let notified = null;
    if (req.body && req.body.emailSubscribers === true) {
      notified = {};
      for (const planId of [...(result.updated || []), ...(result.reset || [])]) {
        try {
          notified[planId] = await require('../lifecycleComms').sendPlanContentsNotice(planId, {});
        } catch (e) {
          console.warn('[admin] contents notice', planId, e.message);
          notified[planId] = { sent: 0, error: e.message };
        }
      }
    }
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(
      req.session.userId,
      'platform.plans_contents',
      `updated=${result.updated.join(',') || 'none'} reset=${result.reset.join(',') || 'none'} unchanged=${result.unchanged.join(',') || 'none'}${notified ? ` notified=${Object.entries(notified).map(([p, n]) => `${p}:${(n && n.sent) || 0}`).join(',') || 'none'}` : ''}`
    );
    ok(res, { ...result, notified });
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});

// ---------- Batch 59: Hostinger one-click deploys ----------
// Settings status + account ping for Admin → Settings → Hostinger.
router.get('/settings/hostinger', async (req, res) => {
  try {
    const dep = require('../hostingerDeploy');
    const cfg = await dep.getConfig();
    ok(res, {
      tokenSet: cfg.tokenSet,
      configured: cfg.configured,
      missing: cfg.missing,
      defaultPriceId: cfg.priceId || '',
      dataCenterId: cfg.dataCenterId,
      templateId: cfg.templateId,
    });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/settings/hostinger/test', async (req, res) => {
  try {
    ok(res, await require('../hostingerDeploy').testConnection());
  } catch (e) {
    fail(res, e, 400);
  }
});

// Per-lead deployment view + actions. The workspaceId query/body arg
// is required: deployments hang off a workspace's lead (the /landing
// signups live in ws1), and the drawer knows its workspace.
function deploymentWorkspace(req) {
  const raw = (req.query && req.query.workspaceId) || (req.body && req.body.workspaceId);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    const e = new Error('workspaceId is required');
    e.code = 'VALIDATION';
    throw e;
  }
  return n;
}
router.get('/leads/:leadId/hostinger-deployment', async (req, res) => {
  try {
    const ws = deploymentWorkspace(req);
    ok(
      res,
      await require('../hostingerDeploy').getLeadDeploymentView(ws, Number(req.params.leadId), {
        withPreview: req.query.preview === '1',
      })
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/leads/:leadId/hostinger-deployment/preview', async (req, res) => {
  try {
    const ws = deploymentWorkspace(req);
    ok(res, await require('../hostingerDeploy').previewForLead(ws, Number(req.params.leadId)));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/leads/:leadId/hostinger-deployment', async (req, res) => {
  try {
    const ws = deploymentWorkspace(req);
    const b = req.body || {};
    const deployment = await require('../hostingerDeploy').startDeployment({
      workspaceId: ws,
      leadId: Number(req.params.leadId),
      actorUserId: req.session.userId,
      confirmText: b.confirmText != null ? String(b.confirmText) : null,
      confirmPriceCents: b.confirmPriceCents != null ? Number(b.confirmPriceCents) : null,
      confirmFirstPeriodCents: b.confirmFirstPeriodCents != null ? Number(b.confirmFirstPeriodCents) : null,
    });
    ok(res, { deployment });
  } catch (e) {
    fail(res, e, e.code === 'DEPLOYMENT_ACTIVE' ? 409 : e.code === 'PRICE_CHANGED' ? 409 : e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
router.post('/leads/:leadId/hostinger-deployment/retry', async (req, res) => {
  try {
    const ws = deploymentWorkspace(req);
    const b = req.body || {};
    const deployment = await require('../hostingerDeploy').retryDeployment({
      workspaceId: ws,
      leadId: Number(req.params.leadId),
      actorUserId: req.session.userId,
      confirmText: b.confirmText != null ? String(b.confirmText) : null,
      confirmPriceCents: b.confirmPriceCents != null ? Number(b.confirmPriceCents) : null,
      confirmFirstPeriodCents: b.confirmFirstPeriodCents != null ? Number(b.confirmFirstPeriodCents) : null,
    });
    ok(res, { deployment });
  } catch (e) {
    fail(res, e, e.code === 'DEPLOYMENT_ACTIVE' ? 409 : e.code === 'PRICE_CHANGED' ? 409 : e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/settings/push', async (req, res) => {
  try {
    const result = await admin.pushDefaultsToWorkspaces({
      force: !!(req.body && req.body.force),
      keys: req.body && req.body.keys,
    });
    await platform.audit(req.session.userId, 'platform.push', JSON.stringify(result));
    ok(res, result);
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Payments / refunds ----------
router.get('/payments', async (req, res) => {
  try {
    const billing = require('../billing');
    ok(res, { payments: await billing.listPayments(req.query) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/refunds', async (req, res) => {
  try {
    const billing = require('../billing');
    ok(res, { refunds: await billing.listRefunds(req.query) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/payments/:id/refund', async (req, res) => {
  try {
    const billing = require('../billing');
    const result = await billing.adminRefundPayment(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'payment.refund', `paymentId=${req.params.id} ${JSON.stringify(result)}`);
    ok(res, result);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- Upsell / Did you know tips ----------
router.get('/upsell-tips', async (req, res) => {
  try {
    const tips = require('../upsellTips');
    ok(res, {
      tips: await tips.listTips({ includeStats: true }),
      features: tips.FEATURE_OPTIONS,
    });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/upsell-tips', async (req, res) => {
  try {
    const tips = require('../upsellTips');
    const tip = await tips.createTip(req.body || {});
    await platform.audit(req.session.userId, 'upsell_tip.create', `id=${tip.id}`);
    ok(res, { tip });
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/upsell-tips/:id', async (req, res) => {
  try {
    const tips = require('../upsellTips');
    const tip = await tips.updateTip(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'upsell_tip.update', `id=${req.params.id}`);
    ok(res, { tip });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/upsell-tips/:id', async (req, res) => {
  try {
    const tips = require('../upsellTips');
    const data = await tips.deleteTip(Number(req.params.id));
    await platform.audit(req.session.userId, 'upsell_tip.delete', `id=${req.params.id}`);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- Domain renewals (Batch 60) ----------
// Renewal mode is derived from the site owner's subscription state by
// server/domainRenewals.js ('auto' while subscribed, 'manual'
// otherwise). Manual renewal is a registrar-dashboard action (the
// Cloudflare API cannot renew), so this endpoint records the intent
// and returns the dashboard link + instructions. The reconcile route
// runs the idempotent sweep on demand (the same pass the hourly
// ticker and the deploy run).
router.post('/domains/renew-manual', async (req, res) => {
  try {
    const ws = deploymentWorkspace(req);
    const domain = String((req.body && req.body.domain) || '').trim();
    if (!domain) {
      const err = new Error('A domain is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const { openWorkspaceDb } = require('../workspaceDb');
    const db = openWorkspaceDb(ws);
    if (!db) {
      const err = new Error('Workspace database not available');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const result = await require('../domainRenewals').requestManualRenewal(
      db,
      ws,
      domain,
      req.session.userId
    );
    await platform.audit(
      req.session.userId,
      'domain.manual_renew_requested',
      `workspaceId=${ws} domain=${result.domain}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, e.status || 400);
  }
});
router.post('/domains/reconcile', async (req, res) => {
  try {
    const renewals = require('../domainRenewals');
    const wsRaw = (req.body && req.body.workspaceId) || (req.query && req.query.workspaceId);
    const result = wsRaw
      ? await renewals.reconcileWorkspaces([Number(wsRaw)])
      : await renewals.reconcileAll();
    await platform.audit(
      req.session.userId,
      'domain.renewals_reconciled',
      `workspaces=${(result.workspaces || []).length} domains=${(result.domains || []).length}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------- Mailing list + newsletter (Batch 71) ----------
// BitPype's OWN mailing list — platform-level, staff (super admin)
// only like everything else in this router. Subscribers are managed
// ONLY here (add / import by the admin); sends honor the list's
// unsubscribes plus the Outreach suppression list. Full rules in
// server/mailingList.js.
const mailingList = require('../mailingList');

router.get('/mailing-list/subscribers', async (req, res) => {
  try {
    ok(res, await mailingList.listSubscribers(req.query || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/mailing-list/subscribers', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await mailingList.addSubscriber({ name: b.name, email: b.email }, { source: 'admin' });
    await platform.audit(
      req.session.userId,
      'mailing_list.add',
      `email=${mailingList.normalizeEmail(b.email)} added=${result.added}${result.reason ? ` reason=${result.reason}` : ''}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.post('/mailing-list/subscribers/import', async (req, res) => {
  try {
    const result = await mailingList.importSubscribers((req.body || {}).text);
    await platform.audit(
      req.session.userId,
      'mailing_list.import',
      `added=${result.added} duplicates=${result.duplicates} blockedUnsubscribed=${result.blockedUnsubscribed} invalid=${result.invalid.length}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.post('/mailing-list/subscribers/:id/unsubscribe', async (req, res) => {
  try {
    const sub = await mailingList.setSubscriberStatus(Number(req.params.id), 'unsubscribed');
    await platform.audit(req.session.userId, 'mailing_list.unsubscribe', `subscriberId=${sub.id} email=${sub.email}`);
    ok(res, { subscriber: sub });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.post('/mailing-list/subscribers/:id/resubscribe', async (req, res) => {
  try {
    const sub = await mailingList.setSubscriberStatus(Number(req.params.id), 'subscribed');
    await platform.audit(req.session.userId, 'mailing_list.resubscribe', `subscriberId=${sub.id} email=${sub.email}`);
    ok(res, { subscriber: sub });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.delete('/mailing-list/subscribers/:id', async (req, res) => {
  try {
    const result = await mailingList.removeSubscriber(Number(req.params.id));
    await platform.audit(req.session.userId, 'mailing_list.remove', `subscriberId=${req.params.id} email=${result.email}`);
    ok(res, result);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.get('/mailing-list/sends', async (req, res) => {
  try {
    ok(res, await mailingList.listSends(req.query || {}));
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/mailing-list/preview', async (req, res) => {
  try {
    const b = req.body || {};
    ok(res, await mailingList.previewNewsletter({ subject: b.subject, bodyHtml: b.bodyHtml, subscriberId: b.subscriberId }));
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.post('/mailing-list/send', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await mailingList.sendNewsletter({
      subject: b.subject,
      bodyHtml: b.bodyHtml,
      previewToken: b.previewToken,
      confirmCount: b.confirmCount,
      createdBy: req.session.userId,
    });
    await platform.audit(
      req.session.userId,
      'mailing_list.send',
      `sendId=${result.sendId} subject=${JSON.stringify(result.subject)} attempted=${result.attempted} sent=${result.sent} failed=${result.failed} skippedSuppressed=${result.skippedSuppressed}`
    );
    ok(res, result);
  } catch (e) {
    fail(res, e, ['VALIDATION', 'PREVIEW_REQUIRED', 'CONFIRM_MISMATCH'].includes(e.code) ? 400 : 500);
  }
});

module.exports = router;
