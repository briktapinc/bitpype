'use strict';

/**
 * Client portal API — isolated from staff via cookie bitpype.portal.sid
 * (staff uses bitpype.sid). Session keys: clientPortalId, clientWorkspaceId, clientLeadId
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const portal = require('../clientPortal');
const { requireCaptcha } = require('../captcha');
const { rateLimit } = require('../rateLimit');
const mfa = require('../mfa');
const apiErrors = require('../apiErrors');

const router = express.Router();

// Batch 103 (SEC-21): auth-event logging must NEVER break portal
// authentication (best-effort; some harnesses whitelist this
// router's module dependencies, so the require may fail quietly).
async function recordAuthEventSafe(evt) {
  try {
    await require('../securityEvents').recordAuthEvent(evt);
  } catch {
    /* audit is best-effort */
  }
}

const accessLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 12 });
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const actionLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const editLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const agentChatLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const chatUploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const captcha = requireCaptcha();

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, e, status = 400) {
  const http =
    e.code === 'NOT_FOUND'
      ? 404
      : e.code === 'INVALID_CREDENTIALS'
        ? 401
        : e.code === 'RATE_LIMITED'
          ? 429
          : e.code === 'EMAIL_FAILED'
            ? 502
            : e.code === 'PAYMENT_REQUIRED' || e.code === 'INSUFFICIENT_CREDITS'
              ? 402
              : e.code === 'PRICE_NOT_CONFIGURED' || e.code === 'STRIPE_NOT_CONFIGURED'
                ? 503
                : e.code === 'BUDGET_EXCEEDED' || e.code === 'AUTOMATION_PAUSED' || e.code === 'AI_NOT_CONFIGURED'
                  ? 403
                  : e.code === 'FORBIDDEN' || e.code === 'PLAN_REQUIRED'
                    ? 403
                    : e.code === 'NO_SELF_BILLING' || e.code === 'NO_CUSTOMER'
                      ? 403
                      : e.code === 'AI_IMPROVEMENT_FAILED' ||
                          e.code === 'AI_REQUEST_FAILED' ||
                          e.code === 'AI_NETWORK_ERROR' ||
                          e.code === 'AI_BAD_RESPONSE' ||
                          e.code === 'AI_DOWNLOAD_FAILED' ||
                          e.code === 'AI_EMPTY' ||
                          e.code === 'MUSE_NETWORK' ||
                          e.code === 'MUSE_BAD_RESPONSE' ||
                          e.code === 'MUSE_REQUEST_FAILED'
                        ? 502
                        : e.code === 'TOO_LONG'
                          ? 400
                          : e.code === 'NO_SITE' ||
                              e.code === 'NOT_EDITABLE' ||
                              e.code === 'NO_VALID_EDITS' ||
                              e.code === 'TOO_MANY' ||
                              e.code === 'EMPTY' ||
                              e.code === 'INVALID' ||
                              e.code === 'INVALID_IMAGE' ||
                              e.code === 'TOO_LARGE' ||
                              e.code === 'NO_SUBSCRIPTION' ||
                              e.code === 'ALREADY_SUBSCRIBED' ||
                              e.code === 'INVALID_PLAN' ||
                              e.code === 'NO_SUBSCRIPTION_ITEM' ||
                              e.code === 'INVALID_ARGS' ||
                              e.code === 'SELF_REFERRAL' ||
                              e.code === 'DUPLICATE'
                            ? 400
                            : typeof e.status === 'number'
                              ? e.status
                              : status;
  apiErrors.sendError(res, e, http, { area: 'portal' });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') return resolve();
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== 'function') return resolve();
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function clearSessionCookie(req, res) {
  const locals = (req.app && req.app.locals) || {};
  const base = locals.portalSessionCookie ||
    locals.sessionCookie || {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    };
  const opts = {
    path: base.path || '/',
    httpOnly: true,
    sameSite: base.sameSite || 'lax',
    secure: !!base.secure,
  };
  if (base.domain) opts.domain = base.domain;
  res.clearCookie(locals.portalSessionName || 'bitpype.portal.sid', opts);
}

function portalIdleMs(req) {
  const fromApp = req.app && req.app.locals && Number(req.app.locals.portalIdleMs);
  if (Number.isFinite(fromApp) && fromApp > 0) return fromApp;
  return 30 * 60 * 60 * 1000;
}

function destroyPortalSession(req, res) {
  return new Promise((resolve) => {
    const finish = () => {
      clearSessionCookie(req, res);
      resolve();
    };
    if (!req.session || typeof req.session.destroy !== 'function') return finish();
    req.session.destroy((err) => {
      if (err) console.warn('[portal] idle destroy:', err.message);
      finish();
    });
  });
}

async function requireClient(req, res, next) {
  try {
    const id = req.session && req.session.clientPortalId;
    if (!id) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });

    const idleMs = portalIdleMs(req);
    const last = Number(req.session.clientLastActiveAt) || 0;
    if (last > 0 && Date.now() - last > idleMs) {
      await destroyPortalSession(req, res);
      return res.status(401).json({
        ok: false,
        error: 'Signed out after 30 hours of inactivity. Please sign in again.',
        code: 'SESSION_IDLE',
      });
    }

    const user = await portal.findById(id);
    if (!user || String(user.status) !== 'active') {
      await destroyPortalSession(req, res);
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' });
    }

    // Rolling idle clock: any authenticated portal API call counts as activity.
    req.session.clientLastActiveAt = Date.now();
    req.client = user;
    next();
  } catch (e) {
    next(e);
  }
}

router.post('/access', accessLimit, captcha, async (req, res) => {
  try {
    const email = req.body && req.body.email;
    ok(res, await portal.requestAccess(email));
  } catch (e) {
    fail(res, e);
  }
});

async function establishPortalSession(req, client) {
  await regenerateSession(req);
  // Portal cookie only (bitpype.portal.sid) — never touches staff bitpype.sid.
  req.session.clientPortalId = client.id;
  req.session.clientWorkspaceId = client.workspaceId;
  req.session.clientLeadId = client.leadId;
  req.session.clientLastActiveAt = Date.now();
  delete req.session.userId;
  delete req.session.workspaceId;
  delete req.session.portalMfaChallenge;
  await saveSession(req);
}

// Batch 40 — portal TOTP is OPT-IN. When a client has enabled it, a
// password (or magic link) alone never establishes the session: the
// login parks a short-lived challenge in the regenerated session and
// POST /mfa/verify completes it. Magic links are gated identically —
// an emailed link must not be a side door around the second factor.
const PORTAL_MFA_CHALLENGE_MS = 10 * 60 * 1000;

async function parkPortalMfaChallenge(req, res, client) {
  await regenerateSession(req);
  delete req.session.clientPortalId;
  delete req.session.clientWorkspaceId;
  delete req.session.clientLeadId;
  delete req.session.userId;
  delete req.session.workspaceId;
  req.session.portalMfaChallenge = {
    portalUserId: client.id,
    expiresAt: Date.now() + PORTAL_MFA_CHALLENGE_MS,
  };
  await saveSession(req);
  ok(res, { mfaRequired: true });
}

function portalMfaChallenge(req) {
  const ch = req.session && req.session.portalMfaChallenge;
  if (!ch || !ch.portalUserId || !ch.expiresAt || ch.expiresAt < Date.now()) {
    if (req.session) delete req.session.portalMfaChallenge;
    return null;
  }
  return ch;
}

router.post('/login', loginLimit, captcha, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const client = await portal.login(email, password);
    if (await mfa.isEnabled('portal', client.id)) {
      return await parkPortalMfaChallenge(req, res, client);
    }
    await establishPortalSession(req, client);
    // Batch 103 (SEC-21): portal login success leaves an auth event.
    await recordAuthEventSafe({
      surface: 'portal',
      event: 'login_success',
      email: email || null,
      userId: client.id,
      workspaceId: client.workspace_id || client.workspaceId || null,
      ip: req.ip,
    });
    ok(res, {
      client: await portal.publicClientWithAccess(client),
      idleMs: portalIdleMs(req),
    });
  } catch (e) {
    // Batch 103 (SEC-21): failed portal logins too (bad credentials,
    // unknown email, disabled account — the thrown code is the detail).
    await recordAuthEventSafe({
      surface: 'portal',
      event: 'login_failure',
      email: (req.body || {}).email || null,
      ip: req.ip,
      detail: (e && (e.code || e.message)) || 'login failed',
    });
    fail(res, e);
  }
});

router.post('/magic-login', loginLimit, async (req, res) => {
  try {
    const token = (req.body && req.body.token) || '';
    const client = await portal.loginWithMagicToken(token);
    if (await mfa.isEnabled('portal', client.id)) {
      return await parkPortalMfaChallenge(req, res, client);
    }
    await establishPortalSession(req, client);
    ok(res, {
      client: await portal.publicClientWithAccess(client),
      idleMs: portalIdleMs(req),
    });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/mfa/verify', loginLimit, async (req, res) => {
  try {
    const ch = portalMfaChallenge(req);
    if (!ch) {
      return res.status(400).json({ ok: false, error: 'Sign in again to continue.', code: 'MFA_CHALLENGE_EXPIRED' });
    }
    await mfa.verifyLoginCode('portal', ch.portalUserId, (req.body || {}).code);
    const row = await portal.findById(ch.portalUserId);
    if (!row || String(row.status) !== 'active') {
      return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS', code: 'INVALID_CREDENTIALS' });
    }
    const client = {
      id: row.id,
      email: row.email,
      workspaceId: row.workspace_id,
      leadId: row.lead_id,
      businessName: row.business_name || '',
      userType: require('../portalTabs').normalizeUserType(row.user_type),
      navOverrides: row.nav_overrides || null,
      moduleOverrides: row.module_overrides || null,
    };
    await establishPortalSession(req, client);
    ok(res, {
      client: await portal.publicClientWithAccess(client),
      idleMs: portalIdleMs(req),
    });
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('MFA_')) {
      const http = e.code === 'MFA_LOCKED' ? 429 : 401;
      return res.status(http).json({ ok: false, error: e.message || e.code, code: e.code });
    }
    fail(res, e);
  }
});

router.post('/logout', (req, res) => {
  const clear = () => {
    clearSessionCookie(req, res);
    ok(res, { loggedOut: true });
  };
  if (!req.session) return clear();
  req.session.destroy((err) => {
    if (err) console.warn('[portal] session destroy:', err.message);
    clear();
  });
});

router.get('/me', requireClient, async (req, res) => {
  try {
    // Batch 119: the portal shell narrows itself to the Billing panel
    // while the account is suspended — /me carries the state so the
    // shell can render it without another round trip. Best-effort:
    // /me must never fail on the suspension read.
    let suspension = null;
    try {
      suspension = await require('../subscriptionSuspension').suspensionForPortalClient(req.client);
    } catch {
      suspension = null;
    }
    const ctx = portal.loadLeadContext(req.client.workspace_id, req.client.lead_id);
    // Domain picker link (Batch 15): only while the site has no custom domain.
    let domainPickerUrl = null;
    try {
      domainPickerUrl =
        require('../domainFlow').pickerLinkForLead(req.client.workspace_id, req.client.lead_id) || null;
    } catch {
      domainPickerUrl = null;
    }
    ok(res, {
      client: await portal.publicClientWithAccess(req.client),
      lead: ctx.lead,
      site: ctx.site
        ? {
            id: ctx.site.id,
            name: ctx.site.name,
            status: ctx.site.status,
            updated_at: ctx.site.updated_at,
          }
        : null,
      domainPickerUrl,
      previewUrl: ctx.previewUrl,
      hasDesignJob: !!(ctx.designJob && ctx.designJob.id),
      idleMs: portalIdleMs(req),
      lastActiveAt: req.session.clientLastActiveAt || null,
      suspension,
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------------------------------------------------------------------------
// Batch 40 — portal MFA management (opt-in TOTP). Mounted with the core
// session routes above (before the tab guard below) so EVERY signed-in
// client — owner or renter — can manage their own second factor.
// ---------------------------------------------------------------------------

function mfaRouteFail(res, e) {
  if (e && e.code && String(e.code).startsWith('MFA_')) {
    const http = e.code === 'MFA_LOCKED' ? 429 : e.code === 'MFA_NO_PENDING' ? 400 : 401;
    return res.status(http).json({ ok: false, error: e.message || e.code, code: e.code });
  }
  return fail(res, e);
}

async function requirePortalPassword(req, userId) {
  const password = String((req.body || {}).password || '');
  const row = await portal.findById(userId);
  const okPw = row ? await bcrypt.compare(password, row.password_hash) : false;
  if (!row || !okPw) {
    throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS' });
  }
  return row;
}

router.get('/mfa', requireClient, async (req, res) => {
  try {
    const state = await mfa.getState('portal', req.client.id);
    ok(res, { enabled: state.enabled });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/mfa/enroll/start', requireClient, actionLimit, async (req, res) => {
  try {
    const row = await requirePortalPassword(req, req.client.id);
    const enrollment = await mfa.startEnrollment('portal', row.id, row.email);
    const qrDataUrl = await QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 220 });
    ok(res, { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl, qrDataUrl });
  } catch (e) {
    mfaRouteFail(res, e);
  }
});

router.post('/mfa/enroll/confirm', requireClient, actionLimit, async (req, res) => {
  try {
    const { recoveryCodes } = await mfa.confirmEnrollment('portal', req.client.id, (req.body || {}).code);
    ok(res, { enabled: true, recoveryCodes });
  } catch (e) {
    mfaRouteFail(res, e);
  }
});

router.post('/mfa/disable', requireClient, actionLimit, async (req, res) => {
  try {
    await requirePortalPassword(req, req.client.id);
    await mfa.verifyLoginCode('portal', req.client.id, (req.body || {}).code);
    await mfa.clearMfa('portal', req.client.id);
    ok(res, { enabled: false });
  } catch (e) {
    mfaRouteFail(res, e);
  }
});

// ---------------------------------------------------------------------------
// Batch 121 — portal set-password flow. Most portal accounts are
// provisioned with a random, never-disclosed password hash (sign-in is
// by magic link), so the password confirm above is a dead end for
// them. These routes email a one-time link that SETS a password (no
// password is ever emailed). Mounted with the core session routes for
// the same reason as MFA: every signed-in client can reach the
// signed-in request, and the signed-out pair must work pre-session.
// ---------------------------------------------------------------------------
const portalPassword = require('../portalPassword');

router.post('/password-set/request', requireClient, actionLimit, async (req, res) => {
  try {
    await portalPassword.requestForUser(req.client.id);
    await recordAuthEventSafe({
      surface: 'portal',
      event: 'password_set_requested',
      email: req.client.email || null,
      userId: req.client.id,
      workspaceId: req.client.workspace_id || null,
      ip: req.ip,
      detail: 'signed-in',
    });
    ok(res, { requested: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/password-set/request-by-email', accessLimit, captcha, async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = await portalPassword.requestByEmail(email);
    // Audit internally only — the response stays generic either way.
    await recordAuthEventSafe({
      surface: 'portal',
      event: 'password_set_requested',
      email: email || null,
      userId: result && result.userId ? result.userId : null,
      ip: req.ip,
      detail: 'signed-out',
    });
    ok(res, { requested: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/password-set/confirm', loginLimit, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await portalPassword.confirmPasswordSet(token, password, {
      keepSessionId: req.sessionID || null,
    });
    await recordAuthEventSafe({
      surface: 'portal',
      event: 'password_set_completed',
      email: result.email || null,
      userId: result.userId,
      workspaceId: result.workspaceId || null,
      ip: req.ip,
    });
    ok(res, { passwordSet: true });
  } catch (e) {
    fail(res, e);
  }
});

// ---------------------------------------------------------------------------
// Batch 29 — per-user tab enforcement. Mounted AFTER the core session
// routes above (/access, /login, /magic-login, /logout, /me — those stay
// reachable by every signed-in user) and BEFORE every panel route below,
// so it runs ahead of all of them. A user whose effective tab set (type
// defaults + admin overrides — server/portalTabs.js) lacks the route's
// tab gets a 403; hiding the nav button alone is never the control.
// Route groups not listed here default to owner-only.
// ---------------------------------------------------------------------------
const portalTabs = require('../portalTabs');

const PORTAL_ROUTE_TABS = [
  ['/site', 'website'],
  ['/changes', 'changes'],
  ['/forms', 'forms'],
  ['/leadscout', 'leadscout'],
  ['/modules', 'modules'],
  ['/social', 'social'],
  ['/calendar', 'social'],
  ['/referrals', 'referrals'],
  ['/mcp', 'mcp'],
  ['/agent-soul', 'soul'],
  ['/analytics', 'analytics'],
  ['/seo', 'seo'],
  ['/rentals', 'rentals'],
  ['/billing', 'billing'],
  ['/upsell-tips', 'billing'],
  ['/gbp', 'gbp'],
  ['/wordpress', 'wordpress'],
];

function tabForbidden(res, tab) {
  return res.status(403).json({
    ok: false,
    error: 'This section is not enabled for your account',
    code: 'TAB_FORBIDDEN',
    ...(tab ? { tab } : {}),
  });
}

async function portalTabGuard(req, res, next) {
  try {
    const defaults = await portalTabs.loadConfiguredDefaults();
    req.portalDefaults = defaults;
    const p = String(req.path || '');
    const hit = PORTAL_ROUTE_TABS.find(([prefix]) => p === prefix || p.startsWith(prefix + '/'));
    if (!hit) {
      // Unmapped portal route group: owner-only by default.
      if (!portalTabs.isOwnerTier(req.client && req.client.user_type)) {
        return tabForbidden(res);
      }
      return next();
    }
    if (!portalTabs.hasTab(req.client, hit[1], defaults)) {
      return tabForbidden(res, hit[1]);
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

// Module-level enforcement (Batch 29, Ely scope update): inside the
// Modules tab, a user may only touch modules in their effective module
// set (type defaults → per-user overrides). The module LIST is filtered
// in its handler; everything under /modules/<something> is gated here.
// Specific sub-paths map to their module; the generic /modules/:type
// routes take the type from the path. Unmapped module sub-paths default
// to owner-only — EXCEPT the ones call tracking itself needs, which are
// all under /modules/calltracking and map to 'calltracking'.
const PORTAL_MODULE_SUBPATHS = [
  ['bookings', 'bookings'],
  ['chatbot', 'chatbot'],
  ['menu', 'menu'],
  ['estimate', 'estimate'],
  ['offers', 'offers'],
  ['socialfeed', 'socialfeed'],
  ['googlereviews', 'googlereviews'],
  ['calltracking', 'calltracking'],
  ['members', 'members'],
  ['ecommerce', 'ecommerce'],
  ['datatables', 'datatables'],
  ['charts', 'charts'],
  ['newsletter', 'newsletter'],
  ['qrcode', 'qrcode'],
];

function moduleForbidden(res, moduleKey) {
  return res.status(403).json({
    ok: false,
    error: 'This module is not enabled for your account',
    code: 'MODULE_FORBIDDEN',
    ...(moduleKey ? { module: moduleKey } : {}),
  });
}

async function portalModuleGuard(req, res, next) {
  try {
    const p = String(req.path || '');
    if (p !== '/modules' && !p.startsWith('/modules/')) return next();
    if (p === '/modules') return next(); // the list handler filters itself
    const seg = p.split('/')[2] || '';
    const specific = PORTAL_MODULE_SUBPATHS.find(([prefix]) => seg === prefix);
    const moduleKey = specific
      ? specific[1]
      : portalTabs.PORTAL_MODULES.includes(seg)
        ? seg
        : null;
    const defaults = req.portalDefaults || (await portalTabs.loadConfiguredDefaults());
    if (!moduleKey) {
      // Unmapped module sub-path (uploads, future endpoints): owner-only.
      if (!portalTabs.isOwnerTier(req.client && req.client.user_type)) {
        return moduleForbidden(res);
      }
      return next();
    }
    if (!portalTabs.hasModule(req.client, moduleKey, defaults)) {
      return moduleForbidden(res, moduleKey);
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

// ---------------------------------------------------------------------------
// Batch 119 — suspension guard: while the account's subscription-
// suspension episode is active, the portal narrows to the Billing
// panel (renewal/payments) so the owner can always sign in and pay,
// and every other panel API refuses with ACCOUNT_SUSPENDED. The core
// session routes above (/me, /mfa, /logout, auth) stay reachable —
// /me carries the suspension state the shell renders. Resolution is
// strictly per client (server/subscriptionSuspension.js): a renter
// covered by someone else's plan is never suspended by that plan.
// ---------------------------------------------------------------------------
async function portalSuspensionGuard(req, res, next) {
  try {
    const p = String(req.path || '');
    if (p === '/billing' || p.startsWith('/billing/')) return next();
    let suspensionModule;
    try {
      suspensionModule = require('../subscriptionSuspension');
    } catch {
      // Stubbed module harnesses (VM-loaded route tests) have no
      // billing layer at all — nothing there can be suspended.
      return next();
    }
    const suspension = await suspensionModule.suspensionForPortalClient(req.client);
    if (!suspension || !suspension.suspended) return next();
    return res.status(403).json({
      ok: false,
      code: 'ACCOUNT_SUSPENDED',
      error:
        'This account is suspended because a subscription payment failed. Your website is unavailable to visitors until the plan is renewed.',
      panel: 'billing',
      suspendedAt: suspension.suspendedAt || null,
      selfServe: suspension.selfServe !== false,
    });
  } catch (e) {
    return next(e);
  }
}

router.use(requireClient, portalSuspensionGuard, portalTabGuard, portalModuleGuard);

// ---------------------------------------------------------------------------
// Batch 84 — Agent SOUL.md page. The document ships as ONE server-side
// source file (server/agent-soul.md, served via server/agentSoul.js) so
// it can be updated in a single place. Access rides the Batch 29 tab
// guard above: PORTAL_ROUTE_TABS maps /agent-soul → 'soul', which the
// owner + partner factory tab sets include and renters lack — a renter
// gets TAB_FORBIDDEN here, never just a hidden nav button. The read
// route returns the rendered HTML for the page plus the raw markdown
// for the Copy action; the download route returns the exact source
// bytes as a file attachment.
// ---------------------------------------------------------------------------
// (agentSoul is required lazily inside the handlers, like the other
// heavy route dependencies in this file, so stubbed VM loaders of this
// module never resolve it.)
router.get('/agent-soul', requireClient, async (req, res) => {
  try {
    const agentSoul = require('../agentSoul');
    const doc = agentSoul.loadSoul();
    ok(res, { filename: agentSoul.DOWNLOAD_FILENAME, markdown: doc.markdown, html: doc.html });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/agent-soul/download', requireClient, async (req, res) => {
  try {
    const agentSoul = require('../agentSoul');
    const doc = agentSoul.loadSoul();
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${agentSoul.DOWNLOAD_FILENAME}"`);
    res.send(doc.markdown);
  } catch (e) {
    fail(res, e, 500);
  }
});

// ---------------------------------------------------------------------------
// Batch 114 — WordPress connector. The free plugin is downloaded HERE:
// every click of the download route mints a NEW registration link and
// renders a fresh zip whose plugin code carries that link (like a
// registration link: it connects exactly one WordPress site to this
// workspace, then it is spent). The list route feeds the panel's
// downloads/registrations table; revoke kills a registration's site
// credential at once (the plugin fails closed on its next call).
// Access rides the Batch 29 tab guard: ['/wordpress' → 'wordpress'],
// owner + partner factory sets; renters get TAB_FORBIDDEN.
// (wpPlugin is required lazily, same pattern as agentSoul above.)
// ---------------------------------------------------------------------------
router.get('/wordpress', requireClient, async (req, res) => {
  try {
    const wpPlugin = require('../wpPlugin');
    const downloads = await wpPlugin.listDownloads(req.client.workspace_id);
    ok(res, { downloads });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/wordpress/download', requireClient, actionLimit, async (req, res) => {
  try {
    const wpPlugin = require('../wpPlugin');
    const { token } = await wpPlugin.mintDownload(req.client.workspace_id, req.client.id);
    const zip = wpPlugin.buildPluginZip({ token, appUrl: wpPlugin.appBaseUrl() });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="bitpype-connector.zip"');
    res.send(zip);
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/wordpress/:id/revoke', requireClient, actionLimit, async (req, res) => {
  try {
    const wpPlugin = require('../wpPlugin');
    await wpPlugin.revokeDownload(req.client.workspace_id, req.params.id);
    const downloads = await wpPlugin.listDownloads(req.client.workspace_id);
    ok(res, { downloads });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

// ---------------------------------------------------------------------------
// Batch 117 — WordPress design editing (plugin v2). State, chat and
// proposal decisions for ONE registration, always resolved through
// the caller's workspace (wpPlugin.findById is workspace-scoped, so
// another workspace's registration is a 404 here, never data).
// Approve-first: these routes stage/decide only — the plugin
// applies and reports back on its own sync cycle.
// ---------------------------------------------------------------------------
router.get('/wordpress/:id/design', requireClient, async (req, res) => {
  try {
    const wpDesign = require('../wpDesign');
    const billing = require('../billing');
    const plans = require('../plans');
    const planId = await billing.workspacePlan(req.client.workspace_id);
    const state = await wpDesign.designStateForPortal(req.client.workspace_id, req.params.id, {
      limit: plans.chatRequestsPerDayFor(planId),
    });
    ok(res, state);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.post('/wordpress/:id/design/chat', requireClient, actionLimit, async (req, res) => {
  try {
    const wpDesignChat = require('../wpDesignChat');
    const data = await wpDesignChat.runWpDesignChat(req.client.workspace_id, req.params.id, req.body || {}, {
      userType: req.client.userType != null ? req.client.userType : req.client.user_type,
    });
    ok(res, data);
  } catch (e) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'UPDATE_REQUIRED' || e.code === 'INVALID' ? 409 : e.code === 'EMPTY' || e.code === 'TOO_LONG' ? 400 : 500;
    fail(res, e, status);
  }
});

router.post('/wordpress/:id/design/proposals/:pid/approve', requireClient, actionLimit, async (req, res) => {
  try {
    const wpDesign = require('../wpDesign');
    const p = await wpDesign.decideProposal(req.client.workspace_id, req.params.id, req.params.pid, 'approve');
    ok(res, { proposal: wpDesign.proposalView(p) });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 409 : 500);
  }
});

router.post('/wordpress/:id/design/proposals/:pid/reject', requireClient, actionLimit, async (req, res) => {
  try {
    const wpDesign = require('../wpDesign');
    const p = await wpDesign.decideProposal(req.client.workspace_id, req.params.id, req.params.pid, 'reject');
    ok(res, { proposal: wpDesign.proposalView(p) });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 409 : 500);
  }
});

router.post('/wordpress/:id/design/proposals/:pid/undo', requireClient, actionLimit, async (req, res) => {
  try {
    const wpDesign = require('../wpDesign');
    const p = await wpDesign.decideProposal(req.client.workspace_id, req.params.id, req.params.pid, 'undo');
    ok(res, { proposal: wpDesign.proposalView(p) });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 409 : 500);
  }
});

router.get('/wordpress/:id/design/proposals/:pid/preview', requireClient, async (req, res) => {
  try {
    const wpPlugin = require('../wpPlugin');
    const wpDesign = require('../wpDesign');
    const link = await wpPlugin.findById(req.client.workspace_id, req.params.id);
    if (!link) return fail(res, Object.assign(new Error('That WordPress connection was not found'), { code: 'NOT_FOUND' }), 404);
    const data = await wpDesign.mintPreview(link, req.params.pid);
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID' ? 409 : 500);
  }
});

router.get('/calendar', requireClient, async (req, res) => {
  try {
    const data = await portal.calendarPosts(req.client.workspace_id, req.client.lead_id, {
      year: req.query.year,
      month: req.query.month,
      clientEmail: req.client.email,
    });
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/social/posts/:id/image', requireClient, actionLimit, async (req, res) => {
  try {
    const data = await portal.generatePostBrandedImage(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.client.email
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.post('/social/generate', requireClient, actionLimit, async (req, res) => {
  try {
    const period = String((req.body && req.body.period) || 'month').toLowerCase() === 'week' ? 'week' : 'month';
    const data = await portal.generateSocial(req.client.workspace_id, req.client.lead_id, req.client.email, period);
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/analytics', requireClient, async (req, res) => {
  try {
    ok(
      res,
      require('../domain').withDb(req.client.workspace_id, (db) =>
        require('../siteAnalytics').report(db, req.client.lead_id, req.query.days)
      )
    );
  } catch (e) {
    fail(res, e);
  }
});
router.post('/analytics', requireClient, actionLimit, async (req, res) => {
  try {
    const data = require('../domain').withDb(req.client.workspace_id, (db) =>
      require('../siteAnalytics').save(db, req.client.workspace_id, req.client.lead_id, req.body || {})
    );
    ok(res, { ...data, publishRequired: true });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/changes', requireClient, async (req, res) => {
  try {
    const requests = portal.listChangeRequests(req.client.workspace_id, req.client.lead_id, {
      limit: req.query.limit,
    });
    ok(res, { requests });
  } catch (e) {
    fail(res, e, e.code === 'FORBIDDEN' ? 403 : 500);
  }
});

router.post('/changes', requireClient, actionLimit, async (req, res) => {
  try {
    const data = await portal.submitChangeRequest(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email,
      req.body || {}
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'EMPTY' ? 400 : 500);
  }
});

/** Editable HTML for the client's own site (session workspace_id + lead_id). */
router.get('/site/render', requireClient, async (req, res) => {
  try {
    const data = portal.renderClientSite(req.client.workspace_id, req.client.lead_id, {
      editable: req.query.editable !== '0' && req.query.editable !== 'false',
      pageSlug: req.query.pageSlug || undefined,
    });
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' || e.code === 'NO_SITE' ? 404 : 500);
  }
});

/**
 * Apply inline text edits from the portal preview iframe.
 * Body: { edits: [{ id: "page:section:path", text: "…" }] }
 * Scoped to the session client’s lead site only; rematerializes public previews.
 */
router.post('/site/edits', requireClient, editLimit, async (req, res) => {
  try {
    // Defense in depth: session lead must match stored client row.
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const edits = (req.body && req.body.edits) || [];
    const data = portal.applyClientTextEdits(req.client.workspace_id, req.client.lead_id, edits);
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

/** Add or delete a list/card/FAQ item (section model), or save freeform HTML after clone/delete. */
router.post('/site/list-item', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    let data;
    if (action === 'freeform-save') {
      data = portal.saveClientPageHtml(req.client.workspace_id, req.client.lead_id, body);
    } else {
      data = portal.mutateClientListItem(req.client.workspace_id, req.client.lead_id, body);
    }
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'LAST_ITEM' || e.code === 'TOO_MANY' || e.code === 'INVALID' ? 400 : 500);
  }
});

/**
 * Replace a site image from portal edit mode.
 * Body: { replaceSrc: "images/hero.jpg", data: "<base64>", mimeType: "image/jpeg" }
 * Client should resize/compress first (max width ~1600). Rematerializes /site-previews.
 */
router.post('/site/image', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientImageUpload(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

/**
 * AI-generate an image and replace a site asset (edit mode).
 * Body: { replaceSrc: "images/hero.jpg", prompt: "…" }
 * Charges credits on Free/Standard; Premium (socialImagesIncluded) is free.
 */
router.post('/site/image-generate', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.generateClientSiteImage(
      req.client.workspace_id,
      req.client.lead_id,
      req.body || {},
      req.client.email
    );
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'INSUFFICIENT_CREDITS' || e.code === 'PAYMENT_REQUIRED' ? 402 : 500);
  }
});

/**
 * Upload or clear the site header logo.
 * Body: { data, mimeType } for image logo, or { mode: "text" } to revert to text brand.
 * Optional brandName. Rematerializes /site-previews.
 */
router.post('/site/logo', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientLogoUpload(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

/**
 * Update site theme colors from the portal.
 * Body: { primary?, secondary?, bg?, text? } — hex colors. Saves a new website version.
 */
router.get('/site/structure', requireClient, async (req, res) => {
  try {
    const data = portal.getClientSiteStructure(req.client.workspace_id, req.client.lead_id);
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/site/structure', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = portal.applyClientStructureReorder(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Canvas pick: return HTML for a design module or widget to insert in edit mode.
 * Does not rewrite page placement (widgets stay inside design modules).
 * Body: { kind: 'layout'|'module'|'form', type?, cols?, formId? }
 */
router.post('/site/canvas-block', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = portal.prepareCanvasBlock(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'INVALID' || e.code === 'NOT_FOUND' ? 400 : 500);
  }
});

router.post('/site/theme', requireClient, editLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyClientThemeColors(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    const code = e && e.code;
    fail(
      res,
      e,
      code === 'INVALID_COLOR' || code === 'EMPTY' || code === 'NO_SITE' || code === 'NOT_FOUND' ? 400 : 500
    );
  }
});

/**
 * Muse agent chat — describe a site improvement; agent edits via client tools and returns fresh preview HTML.
 * Body: { message: string, pageSlug?: string, attachmentIds?: number[] }
 * Batch 96: conversation history is NOT accepted from the client —
 * the pipeline loads the site's server-side transcript tail itself
 * (a history field in the body is ignored).
 * Batch 97: the per-plan daily request cap is checked BEFORE the
 * pipeline runs. A capped turn spends no model call, is never
 * queued, and is answered with an honest limit reply (mode
 * 'limit'); the turn is still recorded so the refusal is visible
 * in the site's transcript. Gate errors fail OPEN (chat stays up;
 * accounting resumes when the gate recovers).
 */
router.post('/site/agent-chat', requireClient, agentChatLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    let gate = null;
    try {
      gate = await portal.gateSiteChatRequest(req.client.workspace_id, req.client.lead_id, {
        userType: req.client.userType,
      });
    } catch (gateErr) {
      console.warn('[portal] chat daily-limit gate failed (failing open):', gateErr.message);
    }
    let data;
    if (gate && !gate.allowed) {
      data = {
        mode: 'limit',
        reply: portal.chatLimitReplyText(gate),
        mutated: false,
        published: false,
        previewUrl: null,
        pendingClarification: false,
        pendingExpired: null,
        chatUsage: { used: gate.used, limit: gate.limit },
      };
    } else {
      data = await portal.runSiteAgentChat(req.client.workspace_id, req.client.lead_id, req.body || {});
      if (gate && gate.limit != null) {
        data.chatUsage = { used: gate.used, limit: gate.limit };
      }
    }
    // Batch 94 — save the completed turn into THIS site's thread
    // so the chat window can show its recent history on open.
    // Best-effort: a history write must never fail the chat.
    let recordedIds = [];
    let recordedUserText = '';
    try {
      const body = req.body || {};
      const userText =
        String(body.message || '').trim() ||
        (Array.isArray(body.attachmentIds) && body.attachmentIds.length ? '[Image attached]' : '');
      recordedUserText = userText;
      const rec = await portal.recordSiteChatTurn(req.client.workspace_id, req.client.lead_id, {
        userText,
        assistantText: data && data.reply ? String(data.reply) : '',
      });
      recordedIds = (rec && rec.ids) || [];
    } catch (histErr) {
      console.warn('[portal] chat history record failed:', histErr.message);
    }
    // Batch 100 — fold the turn into this site's rolling
    // summary (settled facts, changes applied, open items),
    // citing the recorded message ids. Best-effort, same rule.
    try {
      if (data && data.mode !== 'limit') {
        await portal.updateSiteChatSummary(req.client.workspace_id, req.client.lead_id, {
          userText: recordedUserText,
          result: data,
          ids: recordedIds,
        });
      }
    } catch (sumErr) {
      console.warn('[portal] chat summary update failed:', sumErr.message);
    }
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

// Batch 94 — the chat window's initial load: this site's most
// recent CHAT_HISTORY_LIMIT (50) saved messages, oldest-first.
// Session-pinned to the client's own lead, like every chat route.
router.get('/site/agent-chat/history', requireClient, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.getSiteChatHistory(req.client.workspace_id, req.client.lead_id);
    // Batch 97 — today's usage rides along so the chat chrome can
    // show "N of M chat requests today" on open. Best-effort: a
    // usage lookup must never fail the history load.
    try {
      const usage = await portal.getSiteChatUsage(req.client.workspace_id, req.client.lead_id);
      if (usage && usage.limit != null) data.chatUsage = { used: usage.used, limit: usage.limit };
    } catch (usageErr) {
      console.warn('[portal] chat usage lookup failed:', usageErr.message);
    }
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

// Batch 93 — design-agent completions for chat-queued big jobs land
// in the thread through here: returns this lead's undelivered
// assistant messages (e.g. a queued job's completion summary) and
// marks them delivered, so each surfaces exactly once.
router.get('/site/agent-chat/updates', requireClient, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.takeSiteChatUpdates(req.client.workspace_id, req.client.lead_id);
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

// Batch 89 — design-chat image attachments. Upload is base64-in-JSON
// (codebase convention), validated by magic bytes in clientPortal /
// siteChatAttachments (PNG/JPG/WebP/GIF, ≤10 MB, no SVG). There is NO
// public URL for an attachment: the fetch route re-checks the portal
// session's lead on every request, and another lead's id answers 404.
router.post('/site/agent-chat/attachments', requireClient, chatUploadLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.uploadSiteChatImage(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/site/agent-chat/attachments/:id', requireClient, async (req, res) => {
  try {
    if (
      !req.session ||
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const found = portal.fetchSiteChatImage(
      req.client.workspace_id,
      req.client.lead_id,
      Number(req.params.id),
      String(req.query.variant || '')
    );
    if (!found) {
      return fail(res, Object.assign(new Error('Attachment not found'), { code: 'NOT_FOUND' }));
    }
    res.setHeader('Content-Type', found.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `inline; filename="${found.fileName}"`);
    return res.send(found.buffer);
  } catch (e) {
    return fail(res, e);
  }
});

/** Force rematerialize export + refresh public preview (Cloudflare Pages when configured). */
router.post('/site/publish', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.publishClientSitePreview(req.client.workspace_id, req.client.lead_id);
    ok(res, data);
  } catch (e) {
    const code = e && e.code;
    fail(
      res,
      e,
      code === 'NO_SITE' || code === 'NOT_FOUND'
        ? 404
        : code === 'NAV_EXPORT_FAILED' || code === 'PREVIEW_NOT_CONFIGURED'
          ? 422
          : 500
    );
  }
});

router.get('/billing', requireClient, async (req, res) => {
  try {
    ok(res, await portal.billingForClient(req.client.workspace_id, req.client.email));
  } catch (e) {
    fail(res, e, 500);
  }
});

/** Next "Did you know?" upsell tip for Free/basic portal users. */
router.get('/upsell-tips/next', requireClient, async (req, res) => {
  try {
    const billing = require('../billing');
    const tips = require('../upsellTips');
    const planId = await billing.effectivePlan(req.client.workspace_id, { email: req.client.email });
    const result = await tips.nextTipForClient({
      portalUserId: req.client.id,
      planId,
    });
    ok(res, { ...result, plan: planId });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/billing/portal', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.openBillingPortal(req.client.workspace_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/billing/checkout', requireClient, actionLimit, async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || 'standard';
    ok(res, await portal.openCheckout(req.client.workspace_id, req.client.email, plan));
  } catch (e) {
    fail(res, e);
  }
});

/** Switch Free/Standard/Premium — proration update when subscribed; Checkout for first paid plan. */
router.post('/billing/change-plan', requireClient, actionLimit, async (req, res) => {
  try {
    const plan = (req.body && (req.body.plan || req.body.planId)) || '';
    ok(res, await portal.changePlan(req.client.workspace_id, req.client.email, plan));
  } catch (e) {
    fail(res, e);
  }
});

/** Downgrade to Free (cancel at period end). */
router.post('/billing/cancel', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.cancelToFree(req.client.workspace_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

/** Withdraw a scheduled cancel. */
router.post('/billing/resume', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.resumeBilling(req.client.workspace_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/billing/credits/checkout', requireClient, actionLimit, async (req, res) => {
  try {
    const quantity = req.body && req.body.quantity;
    ok(res, await portal.openCreditsCheckout(req.client.workspace_id, req.client.email, quantity));
  } catch (e) {
    fail(res, e);
  }
});

/* ── Referrals ── */

router.get('/referrals', requireClient, async (req, res) => {
  try {
    const referrals = require('../referrals');
    ok(res, await referrals.summaryForPortalUser(req.client));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/referrals', requireClient, actionLimit, async (req, res) => {
  try {
    const referrals = require('../referrals');
    ok(res, {
      referral: referrals.publicReferral(await referrals.createReferral(req.client, req.body || {})),
      ...(await referrals.summaryForPortalUser(req.client)),
    });
  } catch (e) {
    fail(res, e);
  }
});

/* ── Social (Meta connect + schedule) ── */

router.get('/social/accounts', requireClient, async (req, res) => {
  try {
    ok(res, portal.socialAccountsForClient(req.client.workspace_id, req.client.lead_id));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/social/oauth/start', requireClient, async (req, res) => {
  try {
    const returnTo = (req.query && req.query.returnTo) || '/portal?connected=1#/social';
    ok(res, portal.socialOauthStartForClient(req.client.workspace_id, req.client.lead_id, returnTo));
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/social/accounts/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, portal.socialDisconnectForClient(req.client.workspace_id, req.client.lead_id, req.params.id));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.patch('/social/posts/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, {
      post: portal.socialUpdatePostForClient(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {}
      ),
    });
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/social/posts/approve', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      portal.socialApprovePostsForClient(
        req.client.workspace_id,
        req.client.lead_id,
        (req.body && req.body.postIds) || []
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

/* ── Contact forms (multiple per lead) ── */

router.get('/forms', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listContactForms(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/forms', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.createContactForm(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

/** Static paths before /forms/:id */
router.get('/forms/submissions', requireClient, async (req, res) => {
  try {
    ok(
      res,
      await portal.listFormSubmissions(req.client.workspace_id, req.client.lead_id, {
        limit: req.query.limit,
        offset: req.query.offset,
        formId: req.query.formId,
        clientEmail: req.client.email,
      })
    );
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/forms/submissions/:id', requireClient, async (req, res) => {
  try {
    ok(
      res,
      await portal.getFormSubmission(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

// Batch 45 — submission cleanup: hard delete (spam/test), single + bulk.
router.post('/forms/submissions/delete-bulk', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteFormSubmissions(
        req.client.workspace_id,
        req.client.lead_id,
        (req.body && req.body.ids) || [],
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'FORBIDDEN' ? 403 : 400);
  }
});

router.delete('/forms/submissions/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteFormSubmission(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400);
  }
});

router.post('/forms/publish', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(
      res,
      await portal.publishContactForm(
        req.client.workspace_id,
        req.client.lead_id,
        {
          toSite: body.toSite,
          embed_on_page: body.embed_on_page,
          target_page_slug: body.target_page_slug,
          formId: body.formId || body.id,
        },
        body.formId || body.id
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

/** Back-compat: PUT /forms with body.id or first form. */
router.put('/forms', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveContactForm(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email,
        req.body && req.body.id
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.get('/forms/:id', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getContactForm(req.client.workspace_id, req.client.lead_id, req.client.email, req.params.id));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.put('/forms/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveContactForm(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email,
        req.params.id
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/forms/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteContactForm(req.client.workspace_id, req.client.lead_id, req.params.id));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.post('/forms/:id/publish', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(
      res,
      await portal.publishContactForm(
        req.client.workspace_id,
        req.client.lead_id,
        {
          toSite: body.toSite,
          embed_on_page: body.embed_on_page,
          target_page_slug: body.target_page_slug,
        },
        req.params.id
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

/* ── Site modules (Standard / Premium) ── */

router.get('/modules', requireClient, async (req, res) => {
  try {
    const data = await portal.listSiteModules(
      req.client.workspace_id,
      req.client.lead_id,
      req.client.email
    );
    // Batch 29: the module list itself is access-filtered — a user only
    // ever sees modules in their effective set (the endpoints 403 too).
    const defaults = req.portalDefaults || (await portalTabs.loadConfiguredDefaults());
    const visibleModules = portalTabs.modulesForUser(req.client, defaults);
    if (Array.isArray(data.modules)) {
      data.modules = data.modules.filter((m) => visibleModules.includes(m.type));
    }
    data.visibleModules = visibleModules;
    ok(res, data);
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/modules/upload-image', requireClient, actionLimit, async (req, res) => {
  try {
    if (
      Number(req.session.clientLeadId) !== Number(req.client.lead_id) ||
      Number(req.session.clientWorkspaceId) !== Number(req.client.workspace_id)
    ) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const data = await portal.applyModuleAssetUpload(req.client.workspace_id, req.client.lead_id, req.body || {});
    ok(res, data);
  } catch (e) {
    fail(res, e, e.code === 'EMPTY' || e.code === 'INVALID_IMAGE' || e.code === 'TOO_LARGE' ? 400 : 500);
  }
});

/* Bookings admin routes must be registered before /modules/:type/:id */
router.get('/modules/bookings/admin', requireClient, async (req, res) => {
  try {
    const includeArchived =
      req.query.includeArchived === '1' || String(req.query.includeArchived || '').toLowerCase() === 'true';
    ok(
      res,
      await portal.getBookingAdmin(req.client.workspace_id, req.client.lead_id, req.client.email, { includeArchived })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/bookings/settings', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveBookingSettings(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/bookings/hours', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveBookingHours(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/bookings/appointments/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updateBookingAppointment(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// Batch 45 — delete an appointment outright (cancel stays the soft path).
router.delete('/modules/bookings/appointments/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteBookingAppointment(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/modules/bookings/blocks', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.createBookingBlockAdmin(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/bookings/blocks/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteBookingBlockAdmin(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

/* Chatbot admin (must be before /modules/:type) */
router.get('/modules/chatbot/admin', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getChatbotAdmin(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/chatbot/settings', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveChatbotSettings(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

/* Batch 138 — voice bubble image (owner upload for the voice bubble) */
router.post('/modules/chatbot/voice-image', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveChatbotVoiceImage(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'TOO_LARGE' ? 413 : 400);
  }
});

router.delete('/modules/chatbot/voice-image', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.removeChatbotVoiceImage(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.get('/modules/chatbot/voice-image', requireClient, async (req, res) => {
  try {
    const img = await portal.getChatbotVoiceImage(req.client.workspace_id, req.client.lead_id, req.client.email);
    if (!img) return res.status(404).json({ ok: false, error: 'No voice bubble image' });
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(img.buffer);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/chatbot/knowledge/upload', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.uploadChatbotKnowledge(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/chatbot/escalations/:id/resolve', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.resolveChatbotEscalation(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Menu categories — registered BEFORE the generic /modules/:type routes.
router.get('/modules/menu/categories', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listMenuCategories(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/menu/categories', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.createMenuCategory(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email));
  } catch (e) {
    fail(res, e, 400);
  }
});

router.put('/modules/menu/categories/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updateMenuCategory(req.client.workspace_id, req.client.lead_id, req.params.id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.delete('/modules/menu/categories/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteMenuCategory(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Instant Estimate config + request status — before the generic /modules/:type routes.
router.put('/modules/estimate/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveEstimateConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/estimate/requests/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updateEstimateRequest(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Batch 45 — delete an estimate request outright (spam/test cleanup).
router.delete('/modules/estimate/requests/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteEstimateRequest(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Photo Capture (Batch 125) — config + moderation inbox writes,
// before the generic /modules/:type routes so 'photocapture' is
// never parsed as an item id.
router.put('/modules/photocapture/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.savePhotoCaptureConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/photocapture/submissions/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updatePhotoSubmission(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.delete('/modules/photocapture/submissions/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.removePhotoSubmission(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/modules/photocapture/submissions/:id/gallery', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.addPhotoSubmissionToGallery(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Offers display settings (list layout) — before the generic /modules/:type/:id
// routes, which would otherwise read "settings" as an offer id.
router.put('/modules/offers/settings', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveOffersDisplaySettings(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// Categories display scopes (Batch 124) — before the generic
// /modules/:type/:id routes, which would read "scopes" as an id.
router.put('/modules/categories/scopes', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveCategoriesDisplaySettings(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// QR Code display choice + print downloads (Batch 126) — before the
// generic /modules/:type routes, which would otherwise read "qrcode"
// item ids loosely.
router.put('/modules/qrcode/display', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveQrCodeDisplaySettings(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.get('/modules/qrcode/:id/download', requireClient, actionLimit, async (req, res) => {
  try {
    const file = await portal.downloadQrCode(
      req.client.workspace_id,
      req.client.lead_id,
      req.params.id,
      req.query.format,
      req.client.email
    );
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  } catch (e) {
    fail(res, e, e && e.code === 'NOT_FOUND' ? 404 : 400);
  }
});
// Data Tables config + clear (Batch 88) — before the generic
// /modules/:type routes so 'datatables' is never parsed as an id.
router.put('/modules/datatables/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveDataTableConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/datatables/clear', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.clearDataTable(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Social Feed config + manual refresh — before the generic /modules/:type routes.
router.put('/modules/socialfeed/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveSocialFeedConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/socialfeed/refresh', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.refreshSocialFeed(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Newsletter (Batch 118) — before the generic /modules/:type routes.
// The engine is server/newsletter.js (lazy-required like the WordPress
// design engine in Batch 117, so the clientPortal facade's export
// surface is untouched); every route passes the same paid-plan module
// gate the generic module routes enforce internally.
async function newsletterGate(req) {
  await require('../portalModules').requireSiteModules(req.client.workspace_id, req.client.email);
}

router.get('/modules/newsletter/panel', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    ok(res, await require('../newsletter').panelData(req.client.workspace_id, req.client.lead_id));
  } catch (e) {
    fail(res, e);
  }
});

router.get('/modules/newsletter/subscribers', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const nl = require('../newsletter');
    const data = require('../domain').withDb(req.client.workspace_id, (db) => ({
      subscribers: nl.listSubscribers(db, req.client.lead_id, {
        limit: req.query.limit,
        offset: req.query.offset,
        status: req.query.status,
      }),
      counts: nl.countSubscribers(db, req.client.lead_id),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/newsletter/config', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const nl = require('../newsletter');
    const config = require('../domain').withDb(req.client.workspace_id, (db) =>
      nl.saveConfig(db, req.client.lead_id, req.body || {})
    );
    ok(res, { config, from: await nl.resolveFrom(req.client.workspace_id, req.client.lead_id, { config }) });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/newsletter/subscribers', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const nl = require('../newsletter');
    const b = req.body || {};
    const data = require('../domain').withDb(req.client.workspace_id, (db) => {
      const result = nl.addSubscriber(db, req.client.lead_id, {
        email: b.email,
        name: b.name,
        source: 'portal',
      });
      if (result.added) {
        try {
          require('../portalContacts').captureFromNewsletter(db, {
            leadId: req.client.lead_id,
            subscriber: result.subscriber,
          });
        } catch (err) {
          console.warn('[portal newsletter] LeadScout capture failed:', err && err.message);
        }
      }
      return result;
    });
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/newsletter/subscribers/:id/status', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const nl = require('../newsletter');
    const data = require('../domain').withDb(req.client.workspace_id, (db) =>
      nl.setSubscriberStatus(db, req.client.lead_id, req.params.id, (req.body || {}).status)
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/newsletter/subscribers/:id', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const nl = require('../newsletter');
    const data = require('../domain').withDb(req.client.workspace_id, (db) =>
      nl.removeSubscriber(db, req.client.lead_id, req.params.id)
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/newsletter/preview', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const b = req.body || {};
    ok(
      res,
      await require('../newsletter').previewIssue(req.client.workspace_id, req.client.lead_id, {
        subject: b.subject,
        bodyHtml: b.bodyHtml,
        // Batch 122: auto-content blocks from the shared module layer.
        blocks: b.blocks,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/newsletter/send', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const b = req.body || {};
    ok(
      res,
      await require('../newsletter').sendIssue(req.client.workspace_id, req.client.lead_id, {
        subject: b.subject,
        bodyHtml: b.bodyHtml,
        blocks: b.blocks,
        previewToken: b.previewToken,
        confirmCount: b.confirmCount,
        createdBy: req.client.email,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

// Shared module layer (Batch 122) — before the generic /modules/:type
// routes. Sources + items feed the portal pickers (e.g. the event
// editor's gallery album select); refs read/write the generalized
// cross-module links. Everything is scoped to the client's own lead
// by construction (domain.withDb on their workspace + their leadId).
// The gate is the same paid-plan siteModules gate the other module
// routes enforce (newsletterGate wraps requireSiteModules).
router.get('/modules/shared/sources', requireClient, async (req, res) => {
  try {
    await newsletterGate(req);
    const share = require('../moduleShare');
    const data = require('../domain').withDb(req.client.workspace_id, (db) => ({
      sources: share.listSharedSources(db, req.client.lead_id, { sample: 3 }),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/modules/shared/items', requireClient, async (req, res) => {
  try {
    await newsletterGate(req);
    const share = require('../moduleShare');
    const data = require('../domain').withDb(req.client.workspace_id, (db) => ({
      items: share.listSharedItems(db, req.client.lead_id, String(req.query.source || ''), {
        limit: req.query.limit,
      }),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/modules/shared/refs', requireClient, async (req, res) => {
  try {
    await newsletterGate(req);
    const share = require('../moduleShare');
    const data = require('../domain').withDb(req.client.workspace_id, (db) => ({
      refs: share.listSharedRefs(db, req.client.lead_id, {
        consumer_type: req.query.consumer_type,
        consumer_id: req.query.consumer_id,
        provider_type: req.query.provider_type,
      }),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/shared/refs', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const share = require('../moduleShare');
    const data = require('../domain').withDb(req.client.workspace_id, (db) => ({
      ref: share.setSharedRef(db, req.client.lead_id, req.body || {}),
    }));
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/shared/refs', requireClient, actionLimit, async (req, res) => {
  try {
    await newsletterGate(req);
    const share = require('../moduleShare');
    const data = require('../domain').withDb(req.client.workspace_id, (db) =>
      share.clearSharedRef(db, req.client.lead_id, req.body || {})
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
});

// Google Reviews config + manual refresh (Batch 30) — before the
// generic /modules/:type routes. Saving a new Place ID validates it
// against Google first (see clientPortal.saveGoogleReviewsConfig).
router.put('/modules/googlereviews/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveGoogleReviewsConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/googlereviews/refresh', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.refreshGoogleReviews(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Call Tracking — the client saves ONLY their own phone number here
// (Batch 25c split); all forwarding configuration is admin-side.
// Before the generic /modules/:type routes.
router.put('/modules/calltracking/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveCallTrackingConfig(
        req.client.workspace_id,
        req.client.lead_id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// Site Rentals (Batch 26) — the tenant's read-only rental view. The
// lead comes from the portal session, so a request can never name
// another business's rentals.
router.get('/rentals', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getMyRentals(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// AI SEO tool (Batch 22) — the owner's own site only: the lead comes
// from the portal session, so a request can never name another site.
router.get('/seo', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getSeoTool(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/seo/generate', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.generateSeoTool(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/seo/apply', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.applySeoTool(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Batch 31 (I): Google Search Console verification token for the
// owner's own site — emitted as a meta tag on every exported page.
router.post('/seo/gsc', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.setSeoGscToken(
        req.client.workspace_id,
        req.client.lead_id,
        req.client.email,
        (req.body || {}).token || (req.body || {}).gscToken || ''
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

// Google Business Profile manager (Batch 46, Phase 1) — the site
// owner's own profile panel. The lead ALWAYS comes from the portal
// session (req.client.lead_id), never from the request; change sets
// are fetched through getChangeSetForLead, so a change-set id from
// another lead's account resolves to 404 here. Tab gate: '/gbp' →
// 'gbp' in PORTAL_ROUTE_TABS above (owners by factory default).
function portalGbpDb(req) {
  return require('../workspaceDb').openWorkspaceDb(req.client.workspace_id);
}
async function portalGbpCfg() {
  return require('./gbp').loadGbpConfig();
}
function portalGbpFail(res, e) {
  if (e && e.code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: e.message, code: e.code });
  }
  return fail(res, e);
}

router.get('/gbp', requireClient, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const cfg = await portalGbpCfg();
    ok(
      res,
      gbp.panelData(portalGbpDb(req), req.client.lead_id, {
        cfg,
        placesConfigured: !!cfg.placesApiKey,
      })
    );
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.post('/gbp/places-prefill', requireClient, actionLimit, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const cfg = await portalGbpCfg();
    const db = portalGbpDb(req);
    const places = await gbp.placesPrefillForLead(db, req.client.lead_id, { apiKey: cfg.placesApiKey });
    const panel = gbp.panelData(db, req.client.lead_id, {
      cfg,
      placesConfigured: !!cfg.placesApiKey,
      placesState: places.ok ? places.state : null,
    });
    ok(res, {
      places: { ok: places.ok, code: places.code, message: places.message, meta: places.meta || null },
      panel,
    });
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.put('/gbp/connection', requireClient, actionLimit, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const db = portalGbpDb(req);
    const body = req.body || {};
    let conn;
    if (body.action === 'disconnect') conn = gbp.disconnect(db, req.client.lead_id);
    else if (body.place_id !== undefined || body.placeId !== undefined) {
      conn = gbp.setConnectionPlaceId(db, req.client.lead_id, body.place_id != null ? body.place_id : body.placeId);
    } else {
      throw Object.assign(new Error('Nothing to update — pass place_id or an action.'), { code: 'VALIDATION' });
    }
    ok(res, { connection: conn });
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.get('/gbp/oauth/start', requireClient, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const cfg = await portalGbpCfg();
    ok(
      res,
      gbp.buildOauthStart(portalGbpDb(req), {
        workspaceId: req.client.workspace_id,
        leadId: req.client.lead_id,
        actor: `portal:${req.client.id}`,
        returnTo: '/portal?gbp=connected#gbp',
        cfg,
        appUrl: require('./gbp').requestAppUrl(req),
      })
    );
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.post('/gbp/change-sets', requireClient, actionLimit, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const cs = gbp.createChangeSet(portalGbpDb(req), req.client.lead_id, {
      author: `portal:${req.client.id}`,
      state: (req.body || {}).state || {},
    });
    ok(res, { changeSet: cs });
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.get('/gbp/change-sets', requireClient, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    ok(
      res,
      gbp.listChangeSets(portalGbpDb(req), req.client.lead_id, {
        page: req.query.page,
        pageSize: req.query.pageSize || 50,
      })
    );
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.post('/gbp/change-sets/:id/validate', requireClient, actionLimit, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const db = portalGbpDb(req);
    const cs = gbp.getChangeSetForLead(db, req.client.lead_id, Number(req.params.id));
    if (!cs) throw Object.assign(new Error('Change set not found'), { code: 'NOT_FOUND' });
    ok(res, gbp.validateChangeSet(db, cs.id));
  } catch (e) {
    portalGbpFail(res, e);
  }
});

router.post('/gbp/change-sets/:id/push', requireClient, actionLimit, async (req, res) => {
  try {
    const gbp = require('../../src/gbp');
    const cfg = await portalGbpCfg();
    const db = portalGbpDb(req);
    const cs = gbp.getChangeSetForLead(db, req.client.lead_id, Number(req.params.id));
    if (!cs) throw Object.assign(new Error('Change set not found'), { code: 'NOT_FOUND' });
    ok(res, await gbp.pushChangeSet(db, cs.id, { approvalState: cfg.approvalState, googleClient: null }));
  } catch (e) {
    portalGbpFail(res, e);
  }
});

// Membership config — before the generic /modules/:type routes (member
// approve/disable/delete ride the generic PUT/DELETE /modules/members/:id).
router.put('/modules/members/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveMembersConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

// Membership Part 2 — the owner's own Stripe keys (PUT/DELETE must be
// registered before the generic /modules/:type/:id routes, which would
// otherwise read "payments" as a member id).
router.put('/modules/members/payments', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveMembershipKeys(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/members/payments', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.clearMembershipKeys(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Shop Part 2 (Batch 19) — the owner's own Stripe keys for their shop.
// Same placement rule as the members payments routes above: these must
// be registered before the generic /modules/:type/:id routes, which
// would otherwise read "payments" as a product id.
router.put('/modules/ecommerce/payments', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveShopKeys(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/ecommerce/payments', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.clearShopKeys(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/ecommerce/payments/test', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.testShopKeys(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

// Batch 128 — the Checkout module's own settings (success message).
// Same placement rule: before the generic /modules/:type/:id routes.
router.put('/modules/checkout/config', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.saveCheckoutConfig(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

// Membership tiers (paid tiers create their Stripe Price on save).
router.post('/modules/members/tiers', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.createMembershipTier(req.client.workspace_id, req.client.lead_id, req.body || {}, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.put('/modules/members/tiers/:tierId', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updateMembershipTier(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.tierId,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.delete('/modules/members/tiers/:tierId', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteMembershipTier(req.client.workspace_id, req.client.lead_id, req.params.tierId, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

// Owner comps + subscription cancel for one member.
router.post('/modules/members/:id/comp', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.grantMemberComp(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.delete('/modules/members/:id/comp', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.revokeMemberComp(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/modules/members/:id/cancel-subscription', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.cancelMemberSubscription(req.client.workspace_id, req.client.lead_id, req.params.id, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.get('/modules/:type', requireClient, async (req, res) => {
  try {
    const includeArchived =
      req.query.includeArchived === '1' || String(req.query.includeArchived || '').toLowerCase() === 'true';
    ok(
      res,
      await portal.listModuleItems(req.client.workspace_id, req.client.lead_id, req.params.type, req.client.email, {
        includeArchived,
        limit: req.query.limit,
        offset: req.query.offset,
        scope: req.query.scope,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/:type', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.createModuleItem(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.put('/modules/:type/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.updateModuleItem(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/:type/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteModuleItem(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        req.params.id,
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/modules/:type/:id/children', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.addModuleChild(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        req.params.id,
        req.body || {},
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/modules/:type/children/:childId', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.deleteModuleChild(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        req.params.childId,
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 400);
  }
});

router.post('/modules/:type/attach', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body || {};
    ok(
      res,
      await portal.attachSiteModule(
        req.client.workspace_id,
        req.client.lead_id,
        req.params.type,
        {
          title: body.title,
          target_page_slug: body.target_page_slug,
          embed_enabled: body.embed_enabled != null ? body.embed_enabled : body.toSite,
          toSite: body.toSite,
        },
        req.client.email
      )
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/modules/:type/detach', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.detachSiteModule(req.client.workspace_id, req.client.lead_id, req.params.type, req.client.email)
    );
  } catch (e) {
    fail(res, e);
  }
});

// Batch 66 — per-record module DELETE (purge, not detach). Owner-only:
// renters manage only their effective module set day-to-day (Batch 29)
// and module removal destroys the business's content, so it follows
// the owner-only default for destructive module operations. The
// portalModuleGuard above has already scoped :type to the caller's
// effective module set.
router.delete('/modules/:type', requireClient, actionLimit, async (req, res) => {
  try {
    if (!portalTabs.isOwnerTier(req.client && req.client.user_type)) {
      return res.status(403).json({
        ok: false,
        error: 'Only the business owner can delete a module',
        code: 'MODULE_DELETE_OWNER_ONLY',
      });
    }
    ok(
      res,
      await portal.deleteSiteModule(req.client.workspace_id, req.client.lead_id, req.params.type, req.client.email)
    );
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});

/* ── LeadScout (form + booking contacts) ── */

router.get('/leadscout/contacts', requireClient, async (req, res) => {
  try {
    ok(res, {
      contacts: await portal.listLeadScoutContacts(req.client.workspace_id, req.client.lead_id, {
        q: req.query.q,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
      health: await portal.leadScoutHealth(req.client.workspace_id, req.client.lead_id),
    });
  } catch (e) {
    fail(res, e, 500);
  }
});

router.get('/leadscout/contacts/:id', requireClient, async (req, res) => {
  try {
    ok(res, await portal.getLeadScoutContact(req.client.workspace_id, req.client.lead_id, req.params.id));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : 500);
  }
});

router.get('/leadscout/health', requireClient, async (req, res) => {
  try {
    ok(res, await portal.leadScoutHealth(req.client.workspace_id, req.client.lead_id));
  } catch (e) {
    fail(res, e, 500);
  }
});

router.post('/leadscout/retry', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.retryLeadScoutFailures(req.client.workspace_id, req.client.lead_id));
  } catch (e) {
    fail(res, e);
  }
});

// Batch 45 — contact delete (own-business contacts only; the engine
// refuses contacts shared with another business) + clear resolved failures.
router.delete('/leadscout/contacts/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.deleteLeadScoutContact(req.client.workspace_id, req.client.lead_id, req.params.id));
  } catch (e) {
    fail(res, e, e.code === 'NOT_FOUND' ? 404 : e.status || 400);
  }
});

router.post('/leadscout/failures/clear-resolved', requireClient, actionLimit, async (req, res) => {
  try {
    ok(res, await portal.clearLeadScoutResolvedFailures(req.client.workspace_id, req.client.lead_id));
  } catch (e) {
    fail(res, e);
  }
});

/** Standard/Premium: lead-scoped MCP tokens for this client site. */
router.get('/mcp/tokens', requireClient, async (req, res) => {
  try {
    ok(res, await portal.listClientMcpTokens(req.client.workspace_id, req.client.lead_id, req.client.email));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/mcp/token', requireClient, actionLimit, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    ok(
      res,
      await portal.createClientMcpToken(req.client.workspace_id, req.client.lead_id, req.client.email, {
        name: body.name,
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/mcp/token/:id', requireClient, actionLimit, async (req, res) => {
  try {
    ok(
      res,
      await portal.revokeClientMcpToken(req.client.workspace_id, req.client.lead_id, req.client.email, req.params.id)
    );
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
