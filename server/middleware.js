'use strict';

const { getMembership, findWorkspaceByToken } = require('./workspace');

async function loadSessionUser(userId) {
  const billing = require('./billing');
  return billing.getUserBilling(userId);
}

// ---------------------------------------------------------------------------
// Batch 154 (§9) — STAFF absolute session lifetime cap.
//
// Staff cookie maxAge is 14 days and rolling (server.js): activity
// alone kept a staff session alive indefinitely, so a stolen staff
// cookie was a standing credential. A staff session now also dies
// STAFF_ABSOLUTE_SESSION_MS after it was ISSUED (finishStaffLogin in
// server/routes/auth.js stamps req.session.authIssuedAt at the one
// place a login sets userId), however active it has been; the next
// request gets the plain AUTH_REQUIRED 401 the SPA already treats
// as signed-out, and the owner signs in again (password + MFA).
// Sessions minted before this batch carry no stamp and are treated
// as expired — one forced re-login at deploy, fail-closed rather
// than grandfathering an unbounded session a fresh lifetime.
// Portal client sessions are capped separately in
// server/routes/portal.js (Batch 168 S1#2: PORTAL_ABSOLUTE_SESSION_MS,
// 30d default) — they don't pass through the staff choke points.
// Env override follows the PORTAL_IDLE_MS pattern (1h floor).
const STAFF_ABSOLUTE_SESSION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.STAFF_ABSOLUTE_SESSION_MS) || 12 * 60 * 60 * 1000
);

function staffSessionAbsoluteExpired(req) {
  if (!req.session || !req.session.userId) return false;
  const issued = Number(req.session.authIssuedAt) || 0;
  if (!issued) return true;
  return Date.now() - issued > STAFF_ABSOLUTE_SESSION_MS;
}

// ---------------------------------------------------------------------------
// Batch 168 (S1#2) — PORTAL absolute session lifetime cap, the mirror
// of the staff cap above. This copy serves the gates that DO pass
// through middleware consumers — chiefly the call-recording
// playback proxy in routes/calls.js, which resolves portal/staff
// sessions itself instead of passing requireClient/requireAuth.
// routes/portal.js carries its OWN identical copy (it cannot take a
// new cross-file require — VM-loading regression suites stub its
// relative requires); the batch168 suite pins both copies to the
// same default so they cannot drift silently. Portal sessions are
// stamped clientIssuedAt by establishPortalSession
// (routes/portal.js). 30 days by default: portal clients are owners
// checking in occasionally, so the cap is deliberately longer than
// the staff 12h. Env override, 24h floor. An unstamped (pre-168)
// portal session is expired — fail-closed, one forced re-login at
// deploy, exactly like the staff rollout.
const PORTAL_ABSOLUTE_SESSION_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number(process.env.PORTAL_ABSOLUTE_SESSION_MS) || 30 * 24 * 60 * 60 * 1000
);

function portalSessionAbsoluteExpired(session) {
  if (!session || !session.clientPortalId) return false;
  const issued = Number(session.clientIssuedAt) || 0;
  if (!issued) return true;
  return Date.now() - issued > PORTAL_ABSOLUTE_SESSION_MS;
}

function destroySessionQuiet(req) {
  try {
    if (req.session && typeof req.session.destroy === 'function') {
      req.session.destroy(() => {});
    }
  } catch {
    /* best-effort */
  }
  if (req.session) {
    delete req.session.userId;
    delete req.session.workspaceId;
  }
}

/**
 * The staff-session absolute-cap check, shared by requireAuth and
 * requireWorkspace (the two session-validation choke points).
 * Returns true when the request has been refused (caller stops).
 */
function refuseIfStaffSessionExpired(req, res) {
  if (!staffSessionAbsoluteExpired(req)) return false;
  // SEC-21: best-effort audit line, mirroring routes/auth.js —
  // the audit trail must never break authentication.
  try {
    require('./securityEvents')
      .recordAuthEvent({
        surface: 'staff',
        event: 'session_absolute_expired',
        userId: req.session.userId,
        ip: req.ip,
      })
      .catch(() => {});
  } catch {
    /* audit is best-effort */
  }
  destroySessionQuiet(req);
  res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  return true;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  }
  if (refuseIfStaffSessionExpired(req, res)) return;
  loadSessionUser(req.session.userId)
    .then((user) => {
      if (!user || String(user.status || 'active') === 'disabled' || user.deleted_at) {
        return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
      }
      req.sessionUser = user;
      next();
    })
    .catch(next);
}

async function requireWorkspace(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      const ws = await findWorkspaceByToken(token);
      if (!ws) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
      const leadId = ws.lead_id != null && Number(ws.lead_id) > 0 ? Number(ws.lead_id) : null;
      req.auth = {
        via: 'token',
        workspaceId: ws.workspace_id,
        workspace: ws,
        role: 'token',
        leadId,
        tokenId: ws.token_id,
        tokenClass: ws.token_class || null,
      };
      /* Batch 168 (S2#1): the vendor_design token class was enforced
       * only at MCP dispatch (server/mcp.js) — the same credential
       * used over REST walked the full workspace surface, because
       * requireWorkspace never propagated the class and several
       * routes admit 'member'/'token' roles outright (domain
       * registration = real spend included). Enforce the class at
       * this choke point for every REST router mounted behind
       * requireWorkspace; the policy itself lives with the MCP one
       * (vendorTools.vendorRestAllowed). */
      if (req.auth.tokenClass === 'vendor_design') {
        const { vendorRestAllowed } = require('./vendorTools');
        if (!vendorRestAllowed(req.method, req.path)) {
          return res
            .status(403)
            .json({ ok: false, error: 'FORBIDDEN', code: 'VENDOR_TOKEN_FORBIDDEN' });
        }
      }
      return next();
    }

    if (!req.session || !req.session.userId) {
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    }
    if (refuseIfStaffSessionExpired(req, res)) return;

    const user = req.sessionUser || (await loadSessionUser(req.session.userId));
    if (!user || String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    req.sessionUser = user;

    const workspaceId = Number(req.headers['x-workspace-id'] || req.query.workspaceId || req.session.workspaceId || 0);
    if (!workspaceId) {
      return res.status(400).json({ ok: false, error: 'WORKSPACE_REQUIRED' });
    }

    const membership = await getMembership(req.session.userId, workspaceId);
    if (!membership) {
      return res.status(403).json({ ok: false, error: 'NOT_A_MEMBER' });
    }

    req.session.workspaceId = workspaceId;
    req.auth = {
      via: 'session',
      userId: req.session.userId,
      workspaceId,
      workspace: membership,
      role: membership.role,
    };
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Bearer tokens only satisfy an explicit 'token' role (or 'member' for MCP/agent routes).
 * They never satisfy owner/admin — secrets, CF publish, email send need a session role.
 * Any route listing 'member' is reachable by workspace API tokens; pair with
 * denyLeadScopedToken / requireTokenLeadScope when the action is workspace-wide.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (req.auth.via === 'token') {
      if (roles.includes('token') || roles.includes('member')) {
        return next();
      }
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'TOKEN_ROLE_DENIED' });
    }
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    next();
  };
}

/** Reject lead-scoped tokens when the request targets a different lead. */
function requireTokenLeadScope(getLeadId) {
  return (req, res, next) => {
    if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
    let leadId = null;
    try {
      leadId = typeof getLeadId === 'function' ? getLeadId(req) : null;
    } catch {
      leadId = null;
    }
    if (leadId == null || !Number.isFinite(Number(leadId)) || Number(leadId) <= 0) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    if (Number(leadId) !== Number(req.auth.leadId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
    }
    next();
  };
}

/** Block workspace-wide ops for lead-scoped bearer tokens. */
function denyLeadScopedToken(req, res, next) {
  if (req.auth && req.auth.via === 'token' && req.auth.leadId) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  next();
}

/**
 * For lead-scoped tokens: pin req.query.leadId and reject conflicting leadId in body/query.
 * Pass-through for session users and unscoped tokens.
 */
function pinTokenLeadFilter(req, res, next) {
  if (!req.auth || req.auth.via !== 'token' || !req.auth.leadId) return next();
  const scoped = Number(req.auth.leadId);
  const qLead = req.query && req.query.leadId != null ? Number(req.query.leadId) : null;
  const bLead = req.body && req.body.leadId != null ? Number(req.body.leadId) : null;
  if (qLead != null && Number.isFinite(qLead) && qLead > 0 && qLead !== scoped) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  if (bLead != null && Number.isFinite(bLead) && bLead > 0 && bLead !== scoped) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', code: 'LEAD_SCOPE' });
  }
  req.query = { ...(req.query || {}), leadId: String(scoped) };
  if (req.body && typeof req.body === 'object') {
    req.body.leadId = scoped;
  }
  next();
}

async function requireSuperAdmin(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    }
    /* Batch 168 (S1#4): routes mounted behind requireSuperAdmin
     * ALONE (GET /api/v1/openapi.json, the /fingerprints census)
     * skipped the Batch 154 absolute staff cap that requireAuth
     * enforces — the cap is a session property, not a route
     * property, so enforce it here too. */
    if (refuseIfStaffSessionExpired(req, res)) return;
    const { isSuperAdmin } = require('./admin');
    const ok = await isSuperAdmin(req.session.userId);
    if (!ok) return res.status(403).json({ ok: false, error: 'SUPER_ADMIN_REQUIRED' });
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Gate product APIs when billing.require_subscription is on.
 * Free plan counts as access (no Checkout required). Super admins always pass.
 * Session users pass if they OR a workspace owner/admin has product access.
 * MCP bearer tokens pass if any workspace owner/admin has product access.
 */
async function requireSubscription(req, res, next) {
  try {
    const billing = require('./billing');
    const required = await billing.requireSubscriptionEnabled();
    if (!required) return next();

    // Resolve Bearer auth if this middleware runs before requireWorkspace.
    if ((!req.auth || !req.auth.workspaceId) && req.headers.authorization) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const ws = await findWorkspaceByToken(auth.slice(7).trim());
        if (!ws) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
        const leadId = ws.lead_id != null && Number(ws.lead_id) > 0 ? Number(ws.lead_id) : null;
        req.auth = {
          via: 'token',
          workspaceId: ws.workspace_id,
          workspace: ws,
          role: 'token',
          leadId,
          tokenId: ws.token_id,
        };
      }
    }

    if (req.auth && req.auth.via === 'token') {
      const ok = await billing.workspaceHasProductAccess(req.auth.workspaceId);
      if (!ok) {
        // Batch 80: a partner-operated workspace is run by a platform
        // operator account — the partner's token keeps working before
        // the workspace's first paying customer exists.
        try {
          if (await require('./partners').workspaceHasPartner(req.auth.workspaceId)) return next();
        } catch {
          /* fall through to the paywall */
        }
        return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_REQUIRED', code: 'SUBSCRIPTION_REQUIRED' });
      }
      return next();
    }

    const userId = (req.auth && req.auth.userId) || (req.session && req.session.userId);
    if (!userId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    const user = req.sessionUser || (await billing.getUserBilling(userId));
    if (!user) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (String(user.status || 'active') === 'disabled' || user.deleted_at) {
      return res.status(403).json({ ok: false, error: 'ACCOUNT_DISABLED' });
    }
    // Batch 80: partner accounts are platform operators working their
    // own workspace — they never carry a personal subscription, so the
    // paywall never applies to the partner's own session.
    if (user.account_type === 'partner') return next();
    if (billing.hasProductAccess(user)) return next();

    const workspaceId =
      (req.auth && req.auth.workspaceId) ||
      (req.session && req.session.workspaceId) ||
      Number(req.headers['x-workspace-id'] || 0);
    if (workspaceId && (await billing.workspaceHasProductAccess(workspaceId))) {
      return next();
    }

    return res.status(402).json({
      ok: false,
      error: 'SUBSCRIPTION_REQUIRED',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionStatus: user.subscription_status || 'none',
      plan: billing.planOfUser(user),
    });
  } catch (e) {
    next(e);
  }
}

/**
 * Batch 119: while a subscription-suspension episode is active, the
 * suspended account's product-API WRITES stop (reads continue, and
 * the billing/auth surfaces — mounted outside this chain — stay
 * reachable so the owner can pay). Session users are blocked when
 * their own account is suspended; any actor (session or workspace
 * token) is blocked when the workspace they're acting in is under a
 * suspension episode. Super admins are never blocked — staff must be
 * able to work in a suspended workspace to help the customer.
 */
async function blockSuspendedWrites(req, res, next) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const suspension = require('./subscriptionSuspension');
    const sessionUserId = req.session && req.session.userId;
    if (sessionUserId) {
      const user = req.sessionUser || (await loadSessionUser(sessionUserId));
      if (user && Number(user.is_super_admin) === 1) return next();
      if (user && (await suspension.userIsSuspended(user.id))) {
        return res.status(403).json({
          ok: false,
          error: 'ACCOUNT_SUSPENDED',
          code: 'ACCOUNT_SUSPENDED',
          message: 'This account is suspended because a subscription payment failed. Renew the plan to restore write access.',
        });
      }
    }
    const workspaceId =
      (req.auth && req.auth.workspaceId) || Number(req.headers['x-workspace-id'] || (req.session && req.session.workspaceId) || 0);
    if (workspaceId) {
      const wsSuspension = await suspension.getActiveSuspensionForWorkspace(workspaceId);
      if (wsSuspension) {
        return res.status(403).json({
          ok: false,
          error: 'ACCOUNT_SUSPENDED',
          code: 'ACCOUNT_SUSPENDED',
          message: 'This workspace is suspended because a subscription payment failed. Renew the plan to restore write access.',
        });
      }
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = {
  requireAuth,
  requireWorkspace,
  requireRole,
  requireTokenLeadScope,
  denyLeadScopedToken,
  pinTokenLeadFilter,
  requireSuperAdmin,
  requireSubscription,
  blockSuspendedWrites,
  // Batch 154: exported for the regression suite + startup logging.
  STAFF_ABSOLUTE_SESSION_MS,
  staffSessionAbsoluteExpired,
  // Batch 168 (S1#2): the portal mirror.
  PORTAL_ABSOLUTE_SESSION_MS,
  portalSessionAbsoluteExpired,
};
