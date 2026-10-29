'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { createUserWithWorkspace, findUserByEmail, listWorkspacesForUser } = require('../workspace');
const { requireAuth } = require('../middleware');
const { rateLimit } = require('../rateLimit');
const { requireCaptcha } = require('../captcha');
const mfa = require('../mfa');
const apiErrors = require('../apiErrors');

const router = express.Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const captcha = requireCaptcha();

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
  const base = locals.sessionCookie || {
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
  const names = [
    locals.staffSessionName || 'bitpype.sid',
    ...(locals.legacySessionNames || ['scout.sid', 'connect.sid']),
  ];
  for (const name of names) res.clearCookie(name, opts);
}

async function authPayload(user, workspaceId, workspaces) {
  const billing = require('../billing');
  const subscribed = billing.isSubscribed(user);
  const requireSubscription = await billing.requireSubscriptionEnabled();
  const wsId = workspaceId || (workspaces[0] && workspaces[0].id) || null;
  const workspaceSubscribed = wsId ? await billing.workspaceHasSubscription(wsId) : false;
  const workspaceProductAccess = wsId ? await billing.workspaceHasProductAccess(wsId) : false;
  const productAccess = billing.hasProductAccess(user) || workspaceProductAccess;
  const plan = billing.planOfUser(user);
  const workspacePlan = wsId ? await billing.workspacePlan(wsId) : plan;
  const isSuperAdmin = Number(user.is_super_admin) === 1;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
      created_at: user.created_at,
      isSuperAdmin,
      subscriptionStatus: user.subscription_status || 'none',
      currentPeriodEnd: user.current_period_end || null,
      subscribed,
      plan,
    },
    workspaceId: wsId,
    workspaces,
    isSuperAdmin,
    subscribed,
    workspaceSubscribed,
    plan,
    workspacePlan,
    productAccess,
    requireSubscription,
  };
}

// Public auth-screen config (no session): lets the bitpype.com sign-in page
// show or hide its Register tab before anyone is signed in. Exposes only the
// registration flag — mirrors the /api/v1/captcha/config pattern. The client
// portal has no registration and never reads this.
router.get('/config', async (_req, res, next) => {
  try {
    const platform = require('../platform');
    const open = await platform.getPlatformSetting('registration.open', '1');
    res.json({ ok: true, data: { registrationOpen: open === '1' } });
  } catch (e) {
    next(e);
  }
});

router.post('/register', authLimit, captcha, async (req, res, next) => {
  try {
    const platform = require('../platform');
    const open = await platform.getPlatformSetting('registration.open', '1');
    if (open !== '1') {
      return res.status(403).json({ ok: false, error: 'REGISTRATION_DISABLED' });
    }
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    if (maintenance === '1') {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }
    const { email, password, name, workspaceName, acceptTerms } = req.body || {};
    if (!acceptTerms) {
      return res.status(400).json({ ok: false, error: 'You must accept the Terms and Privacy Policy' });
    }
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ ok: false, error: 'password must be at least 8 characters' });
    }
    const existing = await findUserByEmail(email);
    // Do not reveal whether the email is already registered (enumeration).
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Unable to create account', code: 'REGISTRATION_FAILED' });
    }

    let created;
    try {
      created = await createUserWithWorkspace({ email, password, name, workspaceName });
    } catch (e) {
      // Unique-email race: same generic response as the pre-check (no enumeration).
      const msg = String((e && e.message) || e);
      if (/UNIQUE|Duplicate|ER_DUP_ENTRY|email/i.test(msg)) {
        return res.status(400).json({ ok: false, error: 'Unable to create account', code: 'REGISTRATION_FAILED' });
      }
      throw e;
    }
    // Batch 53 (review E-4) — registration must not bypass the MFA gate.
    // Before this fix, register issued a full staff session on password
    // alone, while login parks a second-factor challenge (Batch 40:
    // TOTP required for staff) — so "staff session ⇒ MFA verified" was
    // false for every account's first session. Registration now follows
    // the login path exactly: the account + workspace exist, but the
    // session carries only the short-lived mfaChallenge (stage 'enroll'
    // for a brand-new account) and req.session.userId is set solely by
    // finishStaffLogin once enrollment/verification completes.
    const mfaState = await mfa.getState('staff', created.userId);
    await regenerateSession(req);
    delete req.session.clientPortalId;
    delete req.session.clientWorkspaceId;
    delete req.session.clientLeadId;
    delete req.session.userId;
    delete req.session.workspaceId;
    req.session.mfaChallenge = {
      userId: created.userId,
      email: String(email).trim().toLowerCase(),
      stage: mfaState.enabled ? 'verify' : 'enroll',
      expiresAt: Date.now() + MFA_CHALLENGE_MS,
    };
    await saveSession(req);
    return res.json({
      ok: true,
      data: { mfaRequired: true, mfaStage: req.session.mfaChallenge.stage },
    });
  } catch (e) {
    next(e);
  }
});

// Fixed hash for missing-user path so login timing matches a real bcrypt.compare.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-pad-not-a-real-password', 12);

router.post('/login', authLimit, captcha, async (req, res, next) => {
  try {
    const platform = require('../platform');
    const maintenance = await platform.getPlatformSetting('maintenance_mode', '0');
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    const hash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const ok = await bcrypt.compare(String(password || ''), hash);
    if (!user || !ok) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const isSuper = Number(user.is_super_admin) === 1;
    if (maintenance === '1' && !isSuper) {
      return res.status(503).json({ ok: false, error: 'MAINTENANCE_MODE' });
    }

    // Batch 40 — TOTP is REQUIRED for staff accounts. A correct
    // password alone never issues a session: the login parks a
    // short-lived challenge in the (regenerated) session and the
    // client completes either the forced enrollment (no confirmed
    // TOTP yet) or the code step. req.session.userId is set only by
    // finishStaffLogin, after the second factor succeeds.
    const mfaState = await mfa.getState('staff', user.id);
    await regenerateSession(req);
    delete req.session.clientPortalId;
    delete req.session.clientWorkspaceId;
    delete req.session.clientLeadId;
    delete req.session.userId;
    delete req.session.workspaceId;
    req.session.mfaChallenge = {
      userId: user.id,
      email: user.email,
      stage: mfaState.enabled ? 'verify' : 'enroll',
      expiresAt: Date.now() + MFA_CHALLENGE_MS,
    };
    await saveSession(req);
    return res.json({
      ok: true,
      data: { mfaRequired: true, mfaStage: req.session.mfaChallenge.stage },
    });
  } catch (e) {
    next(e);
  }
});

const MFA_CHALLENGE_MS = 10 * 60 * 1000;

/** Issue the real staff session — the ONLY place login sets userId. */
async function finishStaffLogin(req, res, user) {
  const workspaces = await listWorkspacesForUser(user.id);
  await regenerateSession(req);
  // Staff cookie only — never carry client portal keys on this session.
  delete req.session.clientPortalId;
  delete req.session.clientWorkspaceId;
  delete req.session.clientLeadId;
  delete req.session.mfaChallenge;
  delete req.session.portalMfaChallenge;
  req.session.userId = user.id;
  req.session.workspaceId = workspaces[0] ? workspaces[0].id : null;
  await saveSession(req);
  try {
    await require('../admin').touchLogin(user.id);
  } catch {
    /* ignore */
  }
  return authPayload(user, req.session.workspaceId, workspaces);
}

/** The parked second-factor challenge, or null when absent/expired. */
function staffMfaChallenge(req, stage) {
  const ch = req.session && req.session.mfaChallenge;
  if (!ch || !ch.userId || !ch.expiresAt || ch.expiresAt < Date.now()) {
    if (req.session) delete req.session.mfaChallenge;
    return null;
  }
  if (stage && ch.stage !== stage) return null;
  return ch;
}

function mfaFail(res, e) {
  const http = e.code === 'MFA_LOCKED' ? 429 : e.code === 'MFA_CHALLENGE_EXPIRED' || e.code === 'MFA_NO_PENDING' ? 400 : 401;
  return apiErrors.sendError(res, e, http, { area: 'auth' });
}

/** Re-load the challenged account fresh (status may have changed). */
async function loadStaffUser(ch) {
  const user = await findUserByEmail(ch.email);
  if (!user || Number(user.id) !== Number(ch.userId)) return null;
  if (String(user.status || 'active') === 'disabled' || user.deleted_at) return null;
  return user;
}

router.post('/mfa/enroll/start', authLimit, async (req, res) => {
  try {
    const ch = staffMfaChallenge(req, 'enroll');
    if (!ch) {
      return res.status(400).json({ ok: false, error: 'Sign in again to set up two-factor authentication.', code: 'MFA_CHALLENGE_EXPIRED' });
    }
    const enrollment = await mfa.startEnrollment('staff', ch.userId, ch.email);
    const qrDataUrl = await QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 220 });
    res.json({ ok: true, data: { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl, qrDataUrl } });
  } catch (e) {
    mfaFail(res, e);
  }
});

router.post('/mfa/enroll/confirm', authLimit, async (req, res, next) => {
  try {
    const ch = staffMfaChallenge(req, 'enroll');
    if (!ch) {
      return res.status(400).json({ ok: false, error: 'Sign in again to set up two-factor authentication.', code: 'MFA_CHALLENGE_EXPIRED' });
    }
    const { recoveryCodes } = await mfa.confirmEnrollment('staff', ch.userId, (req.body || {}).code);
    const user = await loadStaffUser(ch);
    if (!user) return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    const payload = await finishStaffLogin(req, res, user);
    res.json({ ok: true, data: { ...payload, mfaEnrolled: true, recoveryCodes } });
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('MFA_')) return mfaFail(res, e);
    next(e);
  }
});

router.post('/mfa/verify', authLimit, async (req, res, next) => {
  try {
    const ch = staffMfaChallenge(req, 'verify');
    if (!ch) {
      return res.status(400).json({ ok: false, error: 'Sign in again to continue.', code: 'MFA_CHALLENGE_EXPIRED' });
    }
    await mfa.verifyLoginCode('staff', ch.userId, (req.body || {}).code);
    const user = await loadStaffUser(ch);
    if (!user) return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    const payload = await finishStaffLogin(req, res, user);
    res.json({ ok: true, data: payload });
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('MFA_')) return mfaFail(res, e);
    next(e);
  }
});

router.post('/forgot-password', authLimit, captcha, async (req, res, next) => {
  try {
    const email = req.body && req.body.email;
    const result = await require('../passwordReset').requestReset(email);
    res.json({ ok: true, data: result });
  } catch (e) {
    next(e);
  }
});

router.post('/reset-password', authLimit, captcha, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    await require('../passwordReset').confirmReset(token, password);
    res.json({ ok: true, data: { reset: true } });
  } catch (e) {
    apiErrors.sendError(res, e, 400, { area: 'auth' });
  }
});

router.post('/accept-invite', requireAuth, async (req, res, next) => {
  try {
    const token = req.body && req.body.token;
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    const result = await require('../invites').acceptInvite(token, req.session.userId);
    req.session.workspaceId = result.workspaceId;
    await saveSession(req);
    const workspaces = await listWorkspacesForUser(req.session.userId);
    const billing = require('../billing');
    const userBilling = await billing.getUserBilling(req.session.userId);
    const productAccess =
      (await billing.workspaceHasProductAccess(result.workspaceId)) || billing.hasProductAccess(userBilling);
    res.json({
      ok: true,
      data: {
        ...result,
        workspaces,
        productAccess,
        workspaceSubscribed: await billing.workspaceHasSubscription(result.workspaceId),
        workspacePlan: await billing.workspacePlan(result.workspaceId),
        plan: billing.planOfUser(userBilling),
      },
    });
  } catch (e) {
    apiErrors.sendError(res, e, 400, { area: 'auth' });
  }
});

router.post('/logout', (req, res) => {
  const finish = () => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  };
  if (!req.session) return finish();
  req.session.destroy((err) => {
    if (err) console.warn('[auth] session destroy:', err.message);
    finish();
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const rows = await require('../db').query(
      `SELECT id, email, name, is_super_admin, status, created_at,
              subscription_status, billing_plan, current_period_end, deleted_at
       FROM users WHERE id = :id LIMIT 1`,
      { id: req.session.userId }
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    const workspaces = await listWorkspacesForUser(user.id);
    const workspaceId = req.session.workspaceId || (workspaces[0] && workspaces[0].id) || null;
    res.json({ ok: true, data: await authPayload(user, workspaceId, workspaces) });
  } catch (e) {
    next(e);
  }
});

router.post('/workspace', requireAuth, async (req, res, next) => {
  try {
    const workspaceId = Number(req.body && req.body.workspaceId);
    if (!workspaceId) return res.status(400).json({ ok: false, error: 'workspaceId required' });
    const membership = await require('../workspace').getMembership(req.session.userId, workspaceId);
    if (!membership) return res.status(403).json({ ok: false, error: 'NOT_A_MEMBER' });
    req.session.workspaceId = workspaceId;
    await saveSession(req);
    const billing = require('../billing');
    const user = await billing.getUserBilling(req.session.userId);
    const workspaceSubscribed = await billing.workspaceHasSubscription(workspaceId);
    const workspacePlan = await billing.workspacePlan(workspaceId);
    const productAccess = billing.hasProductAccess(user) || (await billing.workspaceHasProductAccess(workspaceId));
    res.json({
      ok: true,
      data: {
        workspaceId,
        workspace: membership,
        workspaceSubscribed,
        workspacePlan,
        plan: billing.planOfUser(user),
        productAccess,
        subscribed: billing.isSubscribed(user),
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
