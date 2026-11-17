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
// Batch 103 (SEC-08): MCP dispatch audit log — super-admin only via
// the router-level gate above. 90-day retention is enforced at write.
router.get('/mcp-audit', async (req, res) => {
  try {
    const securityEvents = require('../securityEvents');
    const rows = await securityEvents.listMcpAudit({
      workspaceId: req.query.workspaceId ? Number(req.query.workspaceId) : null,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    ok(res, { entries: rows });
  } catch (e) {
    fail(res, e, 500);
  }
});

// Batch 103 (SEC-21): auth events (logins, MFA failures/lockouts,
// MCP 401s) — the queryable trace Audit 2 §L found missing.
router.get('/auth-events', async (req, res) => {
  try {
    const securityEvents = require('../securityEvents');
    const rows = await securityEvents.listAuthEvents({
      surface: req.query.surface || null,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    ok(res, { entries: rows });
  } catch (e) {
    fail(res, e, 500);
  }
});

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

// ---------- Portal Training modules (Batch 194) ----------
// The learning catalog behind the portal Training tab: add / edit /
// remove / reorder / publish-toggle. Unpublished modules never reach
// the portal list (server/learningModules.js listPublished).
router.get('/training-modules', async (req, res) => {
  try {
    ok(res, { modules: await require('../learningModules').listAll() });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/training-modules', async (req, res) => {
  try {
    const data = await require('../learningModules').createModule(req.body || {});
    await platform.audit(req.session.userId, 'training_module.create', `slug=${data.slug} title=${data.title}`);
    ok(res, { module: data });
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 400 : 500);
  }
});
router.put('/training-modules/reorder', async (req, res) => {
  try {
    const ids = (req.body && (req.body.orderedIds || req.body.ids)) || [];
    const modules = await require('../learningModules').reorderModules(ids);
    await platform.audit(req.session.userId, 'training_module.reorder', `ids=${ids.join(',')}`);
    ok(res, { modules });
  } catch (e) {
    fail(res, e, e.code === 'INVALID' ? 400 : 500);
  }
});
router.patch('/training-modules/:id', async (req, res) => {
  try {
    const data = await require('../learningModules').updateModule(Number(req.params.id), req.body || {});
    await platform.audit(req.session.userId, 'training_module.update', `id=${req.params.id} ${JSON.stringify(req.body || {}).slice(0, 500)}`);
    ok(res, { module: data });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 400 : 500);
  }
});
// Batch 195 — replace a module's video with an uploaded file.
// Base64-in-JSON like the platform's other admin uploads (branding
// logo); server/trainingVideos.js validates (mp4 magic bytes, 50 MB
// cap), stores on the data volume, and points the module's URL field
// at the canonical /training/ (or /training-mobile/) path. The URL
// fields above keep working unchanged for hosted files.
router.post('/training-modules/:id/video', async (req, res) => {
  try {
    const b = req.body || {};
    const raw = String(b.dataBase64 || b.data || '');
    const buf = raw ? Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64') : Buffer.alloc(0);
    const out = await require('../trainingVideos').replaceModuleVideo(Number(req.params.id), String(b.slot || 'main'), buf);
    await platform.audit(
      req.session.userId,
      'training_module.video_replace',
      `id=${req.params.id} slot=${out.slot} url=${out.url} bytes=${out.bytes}`
    );
    ok(res, out);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' || e.code === 'EMPTY' || e.code === 'TOO_LARGE' || e.code === 'INVALID_VIDEO' ? 400 : 500);
  }
});
router.delete('/training-modules/:id', async (req, res) => {
  try {
    const data = await require('../learningModules').deleteModule(Number(req.params.id));
    // Batch 195: drop the module's uploaded videos with it (the baked
    // seed files in public/ are never touched). Best-effort.
    try {
      require('../trainingVideos').deleteModuleVideos(data.slug);
    } catch {
      /* file cleanup never blocks the delete */
    }
    await platform.audit(req.session.userId, 'training_module.delete', `id=${req.params.id} slug=${data.slug}`);
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
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
// Batch 87 — Branding: the site logo for dark/light screens + the
// tagline state for the Admin → Settings → Branding panel. Reads are
// served from the sync branding cache (primed at boot, refreshed on
// every branding.* write); logo uploads are base64-in-JSON like the
// platform's other admin image paths, validated + stored on the data
// volume by server/branding.js. The tagline itself saves through the
// generic PUT /settings above (branding.tagline def).
router.get('/settings/branding', async (req, res) => {
  try {
    const branding = require('../branding');
    await branding.refreshBranding();
    ok(res, branding.brandingState());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/settings/branding/logo', async (req, res) => {
  try {
    const branding = require('../branding');
    const b = req.body || {};
    const raw = String(b.dataBase64 || b.data || '');
    const buf = raw ? Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64') : Buffer.alloc(0);
    const out = await branding.saveLogo(String(b.variant || ''), buf);
    await platform.audit(req.session.userId, 'branding.logo', `variant=${b.variant} url=${out.url} bytes=${out.bytes}`);
    ok(res, out);
  } catch (e) {
    fail(res, e, 400);
  }
});
router.post('/settings/branding/logo/reset', async (req, res) => {
  try {
    const branding = require('../branding');
    const variant = String((req.body || {}).variant || '');
    const out = await branding.resetLogo(variant);
    await platform.audit(req.session.userId, 'branding.logo_reset', `variant=${variant}`);
    ok(res, out);
  } catch (e) {
    fail(res, e, 400);
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
// ---------- AI provider routing (Batch 120) ----------
// Which API does what: per-function primary/fallback + model
// overrides, stored as the ai.route.* platform settings and resolved
// by server/aiRouting.js for BOTH AI stacks. The GET never returns
// key material — profiles report configured/not-configured, host and
// default model only. The PUT validates the whole matrix, writes it
// through the settings choke point, and audits the change.
router.get('/settings/ai-routing', async (req, res) => {
  try {
    const aiRouting = require('../aiRouting');
    ok(res, await aiRouting.adminState());
  } catch (e) {
    fail(res, e);
  }
});
router.put('/settings/ai-routing', async (req, res) => {
  try {
    const aiRouting = require('../aiRouting');
    const entries = aiRouting.validateRoutesPayload(req.body && req.body.routes);
    await platform.setPlatformSettingsBatch(entries);
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    const summary = Object.entries(entries)
      .map(([k, v]) => `${k.replace(/^ai\.route\./, '')}=${v || '(provider default)'}`)
      .join('; ');
    await platform.audit(req.session.userId, 'platform.ai_routing', summary.slice(0, 900));
    ok(res, { updated: Object.keys(entries).length, state: await aiRouting.adminState() });
  } catch (e) {
    fail(res, e);
  }
});
// ---------- Assistant chat billing (Batch 161) ----------
// Ely's knobs for the Assistant chat charge: the margin % (seeded
// 20, his figure), the optional per-workspace monthly billed-usage
// cap, and the per provider/model price table raw costs are
// computed from. All platform settings — nothing hard-coded — and
// every recorded ai_usage row keeps the margin that was applied to
// it, so edits here only ever affect future calls.
router.get('/settings/ai-assistant', async (req, res) => {
  try {
    const assistantChat = require('../assistantChat');
    ok(res, await assistantChat.getAssistantSettings());
  } catch (e) {
    fail(res, e);
  }
});
router.put('/settings/ai-assistant', async (req, res) => {
  try {
    const assistantChat = require('../assistantChat');
    const entries = await assistantChat.validateAssistantSettings(req.body || {});
    await platform.setPlatformSettingsBatch(entries);
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(
      req.session.userId,
      'platform.ai_assistant_settings',
      Object.entries(entries)
        .map(([k, v]) => `${k}=${k === assistantChat.SETTING_PRICES ? '(price table)' : v}`)
        .join('; ')
        .slice(0, 900)
    );
    ok(res, { updated: Object.keys(entries).length, state: await assistantChat.getAssistantSettings() });
  } catch (e) {
    fail(res, e);
  }
});
router.get('/settings/ai-assistant/usage', async (req, res) => {
  try {
    const assistantChat = require('../assistantChat');
    const assistantBilling = require('../assistantBilling');
    const month = String(req.query.month || assistantChat.monthKey()).slice(0, 7);
    ok(res, await assistantBilling.adminUsageOverview(month));
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

// ---------- Design agent: design types (Batch 153) ----------
// The design-type catalog (type + default instructions) behind the
// New design job popup's Type select: stored as the design.types
// platform setting and resolved by server/designTypes.js. The GET
// returns the resolved list (the code seed until an admin saves);
// the PUT replaces the whole list — validation is atomic, a
// rejected save writes nothing.
router.get('/settings/design-types', async (req, res) => {
  try {
    ok(res, await require('../designTypes').adminState());
  } catch (e) {
    fail(res, e, 500);
  }
});
router.put('/settings/design-types', async (req, res) => {
  try {
    const result = await require('../designTypes').updateDesignTypes(req.body && req.body.types);
    try {
      await platform.savePlatformDefaultsSnapshot();
    } catch (e) {
      console.warn('[admin] defaults snapshot', e.message);
    }
    await platform.audit(
      req.session.userId,
      'platform.design_types',
      `types=${result.types.map((t) => t.type).join(',')}`.slice(0, 900)
    );
    ok(res, result);
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

// ---------- Batch 119: subscription suspensions ----------
// Staff visibility into payment-failure suspensions (reason + date +
// weekly-email count) and a manual unsuspend for support cases. The
// manual path uses the same restore as a successful payment: markers
// cleared, episode closed, audit row written.
router.get('/suspensions', async (req, res) => {
  try {
    const suspension = require('../subscriptionSuspension');
    ok(res, { suspensions: await suspension.listActiveSuspensions() });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/suspensions/:userId/unsuspend', async (req, res) => {
  try {
    const suspension = require('../subscriptionSuspension');
    const result = await suspension.restoreForUser(Number(req.params.userId), {}, { via: 'admin_manual', force: true });
    if (!result) {
      return res.status(404).json({ ok: false, error: 'No active suspension for this account' });
    }
    await platform.audit(
      req.session.userId,
      'subscription.unsuspend',
      `userId=${req.params.userId} suspensionId=${result.id}`
    );
    ok(res, { restored: true, suspensionId: result.id });
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

// ---------- Webinars (Batch 163) ----------
// Platform-level, staff (super admin) only like everything else in
// this router. Ely creates webinars here; the public side is the gate
// + room in server/routes/webinarsPublic.js. Full rules in
// server/webinars.js.
const webinars = require('../webinars');

function webinarPayload(w, req) {
  if (!w) return w;
  const origin = (() => {
    try {
      return new URL(require('../stripeClient').appUrl()).origin;
    } catch {
      return '';
    }
  })();
  return { ...w, sharePath: webinars.sharePath(w), shareUrl: origin ? origin + webinars.sharePath(w) : webinars.sharePath(w), chatEffectivelyOpen: webinars.chatEffectivelyOpen(w) };
}

router.get('/webinars', async (req, res) => {
  try {
    const rows = await webinars.listWebinars();
    ok(res, { webinars: rows.map((w) => webinarPayload(w, req)) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/webinars', async (req, res) => {
  try {
    const w = await webinars.createWebinar(req.body || {}, req.session.userId);
    await platform.audit(req.session.userId, 'webinar.create', `id=${w.id} slug=${w.slug} title=${JSON.stringify(w.title)}`);
    ok(res, { webinar: webinarPayload(w, req) });
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.get('/webinars/:id', async (req, res) => {
  try {
    const w = await webinars.getWebinarById(req.params.id);
    if (!w) return fail(res, Object.assign(new Error('Webinar not found'), { code: 'NOT_FOUND' }), 404);
    ok(res, { webinar: webinarPayload(w, req) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.patch('/webinars/:id', async (req, res) => {
  try {
    const w = await webinars.updateWebinar(req.params.id, req.body || {});
    await platform.audit(req.session.userId, 'webinar.update', `id=${w.id} status=${w.status}`);
    ok(res, { webinar: webinarPayload(w, req) });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.delete('/webinars/:id', async (req, res) => {
  try {
    const result = await webinars.deleteWebinar(req.params.id);
    await platform.audit(req.session.userId, 'webinar.delete', `id=${result.id} slug=${result.slug}`);
    ok(res, result);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.post('/webinars/:id/regen-code', async (req, res) => {
  try {
    const w = await webinars.regenerateCode(req.params.id);
    await platform.audit(req.session.userId, 'webinar.regen_code', `id=${w.id} slug=${w.slug}`);
    ok(res, { webinar: webinarPayload(w, req) });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});
router.get('/webinars/:id/registrations', async (req, res) => {
  try {
    const w = await webinars.getWebinarById(req.params.id);
    if (!w) return fail(res, Object.assign(new Error('Webinar not found'), { code: 'NOT_FOUND' }), 404);
    ok(res, { registrations: await webinars.listRegistrations(w.id) });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.get('/webinars/:id/messages', async (req, res) => {
  try {
    const w = await webinars.getWebinarById(req.params.id);
    if (!w) return fail(res, Object.assign(new Error('Webinar not found'), { code: 'NOT_FOUND' }), 404);
    const messages = await webinars.listMessages(w.id, {
      afterId: Number(req.query.after || 0),
      includeHidden: true,
      limit: Number(req.query.limit || 200),
    });
    ok(res, { messages, chatEffectivelyOpen: webinars.chatEffectivelyOpen(w), status: w.status });
  } catch (e) {
    fail(res, e, 500);
  }
});
router.post('/webinars/:id/messages', async (req, res) => {
  try {
    const w = await webinars.getWebinarById(req.params.id);
    if (!w) return fail(res, Object.assign(new Error('Webinar not found'), { code: 'NOT_FOUND' }), 404);
    const hostName = 'Host';
    const message = await webinars.postMessage(w, { hostName, body: (req.body || {}).body });
    ok(res, { message });
  } catch (e) {
    fail(res, e, e.code === 'VALIDATION' ? 400 : 500);
  }
});
router.post('/webinars/:id/messages/:mid/hide', async (req, res) => {
  try {
    const message = await webinars.setMessageHidden(req.params.id, req.params.mid, !!(req.body || {}).hidden);
    ok(res, { message });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

module.exports = router;
