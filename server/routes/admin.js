'use strict';

const express = require('express');
const admin = require('../admin');
const platform = require('../platform');
const { requireAuth, requireSuperAdmin } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, e, status = 400) {
  const code = e.code || status;
  const http = typeof code === 'number' ? code : e.code === 'NOT_FOUND' ? 404 : status;
  res.status(http >= 400 && http < 600 ? http : 400).json({
    ok: false,
    error: e.message || String(e),
    code: e.code,
  });
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
    ok(res, {
      settings,
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

module.exports = router;
