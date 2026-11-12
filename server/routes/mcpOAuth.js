'use strict';

/**
 * MCP OAuth HTTP routes for Claude.ai (and other OAuth MCP clients).
 * Public: discovery, DCR, token. Session: /authorize + /oauth/consent (portal cookie).
 */

const path = require('path');
const express = require('express');
const oauth = require('../mcpOAuth');
const portal = require('../clientPortal');
const { rateLimit } = require('../rateLimit');

const publicRouter = express.Router();
const sessionRouter = express.Router();

const tokenLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const consentLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const registerLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });

/* Batch 168 (S1#7): a pending authorization request parked in the
 * session never expired — a consent completed hours/days after the
 * /authorize hit (session still alive) minted a code for a request
 * the client had long abandoned. The parked request now carries
 * the same 10-minute TTL as the authorization code itself; readers
 * go through pendingAlive(), which clears a stale entry. */
const PENDING_TTL_MS = 10 * 60 * 1000;
function pendingAlive(req) {
  const pending = req.session && req.session.oauthPending;
  if (!pending) return null;
  if (!pending.pendingExpiresAt || Number(pending.pendingExpiresAt) <= Date.now()) {
    delete req.session.oauthPending;
    return null;
  }
  return pending;
}

function sendJson(res, status, body) {
  res.status(status).type('application/json').json(body);
}

function oauthError(res, err) {
  const status = Number(err.status) || 400;
  const code = err.oauth || err.code || 'invalid_request';
  sendJson(res, status, {
    error: code,
    error_description: err.message || 'Request failed',
  });
}

function corsPublic(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

publicRouter.use(
  [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/register',
    '/token',
  ],
  corsPublic
);

publicRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  sendJson(res, 200, oauth.protectedResourceMetadata());
});

publicRouter.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  sendJson(res, 200, oauth.protectedResourceMetadata());
});

publicRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  sendJson(res, 200, oauth.authorizationServerMetadata());
});

publicRouter.get('/.well-known/openid-configuration', (_req, res) => {
  sendJson(res, 200, oauth.authorizationServerMetadata());
});

publicRouter.post('/register', registerLimit, async (req, res) => {
  try {
    const registered = await oauth.registerClient(req.body || {});
    sendJson(res, 201, registered);
  } catch (e) {
    oauthError(res, e);
  }
});

publicRouter.post('/token', tokenLimit, async (req, res) => {
  try {
    // RFC 6749: application/x-www-form-urlencoded (also accept JSON for tooling).
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const tokens = await oauth.handleTokenRequest(body);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    sendJson(res, 200, tokens);
  } catch (e) {
    // Never echo tokens or verifiers.
    console.warn('[mcp-oauth] token exchange failed:', e.oauth || e.code || e.message);
    oauthError(res, e);
  }
});

/* Batch 180 (M7): the consent surface must apply the SAME portal
 * session lifetime rules requireClient enforces (Batch 168 S1#2) —
 * 30h idle (app locals portalIdleMs, same fallback) + the 30-day
 * absolute cap from issuance (unstamped = expired, fail-closed).
 * Mirrored locally, exactly like routes/portal.js carries its own
 * copy and middleware.js carries another (the batch168 suite pins
 * the copies to the same defaults); before this, loadPortalUser
 * checked account status only, so a session past both caps could
 * still mint 90/180-day OAuth tokens here. */
const PORTAL_ABSOLUTE_SESSION_MS = Math.max(
  24 * 60 * 60 * 1000,
  // typeof-guarded, same as routes/portal.js: VM-loading suites may
  // evaluate this file in a sandbox with no `process` global.
  (typeof process !== 'undefined' ? Number(process.env.PORTAL_ABSOLUTE_SESSION_MS) : 0) || 30 * 24 * 60 * 60 * 1000
);
function portalSessionExpired(req) {
  const session = req.session;
  if (!session || !session.clientPortalId) return false;
  const idleMs = Number(req.app && req.app.locals && req.app.locals.portalIdleMs) || 30 * 60 * 60 * 1000;
  const last = Number(session.clientLastActiveAt) || 0;
  if (last > 0 && Date.now() - last > idleMs) return true;
  const issued = Number(session.clientIssuedAt) || 0;
  if (!issued) return true;
  return Date.now() - issued > PORTAL_ABSOLUTE_SESSION_MS;
}

async function loadPortalUser(req) {
  const id = req.session && req.session.clientPortalId;
  if (!id) return null;
  if (portalSessionExpired(req)) return null;
  const user = await portal.findById(id);
  if (!user || String(user.status) !== 'active') return null;
  return user;
}

/* Batch 180 (L2): a pending authorization request is bound to the
 * portal user who was authenticated when it was parked. A request
 * parked pre-authentication (or by a different user) can never be
 * consented by whoever happens to be signed in later — the flow
 * must be restarted from /authorize while signed in, which parks a
 * freshly-bound request (portal sign-in itself regenerates the
 * session, destroying any earlier park, as before). */
function pendingBoundTo(pending, user) {
  return !!(pending && user && pending.boundPortalUserId != null && Number(pending.boundPortalUserId) === Number(user.id));
}

sessionRouter.get('/authorize', async (req, res) => {
  try {
    const validated = await oauth.validateAuthorizeParams(req.query || {});
    if (!validated.ok) {
      const redirectUri = String((req.query && req.query.redirect_uri) || '');
      const state = req.query && req.query.state != null ? String(req.query.state) : '';
      const client = await oauth.getClient(String((req.query && req.query.client_id) || ''));
      if (client && redirectUri && oauth.redirectUriAllowed(client, redirectUri)) {
        return res.redirect(
          302,
          oauth.oauthErrorRedirect(redirectUri, state, validated.error, validated.error_description)
        );
      }
      return res
        .status(400)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>Authorize</title>` +
            `<p>${escapeHtml(validated.error_description || validated.error)}</p>`
        );
    }

    // Batch 180 (L2): bind the parked request to the portal user
    // authenticated RIGHT NOW (null when nobody is signed in — such
    // a park is display-only and can never be consented; see
    // pendingBoundTo and the consent gate below).
    const parkingUser = await loadPortalUser(req);
    req.session.oauthPending = {
      ...validated.pending,
      pendingExpiresAt: Date.now() + PENDING_TTL_MS,
      boundPortalUserId: parkingUser ? Number(parkingUser.id) : null,
    };
    await saveSession(req);
    return res.sendFile(path.join(__dirname, '..', '..', 'public', 'authorize.html'));
  } catch (e) {
    console.error('[mcp-oauth] authorize:', e.message);
    return res.status(500).type('html').send('<p>Authorization failed.</p>');
  }
});

sessionRouter.get('/oauth/pending', async (req, res) => {
  try {
    const pending = pendingAlive(req);
    if (!pending) {
      return sendJson(res, 400, { ok: false, error: 'NO_PENDING', message: 'No pending authorization request' });
    }
    const user = await loadPortalUser(req);
    // Batch 180 (L2): an authenticated user who is NOT the user this
    // request was parked for never even sees it as consentable —
    // destroy the park (a signed-out visitor still sees it, so the
    // sign-in panel can explain which app is asking).
    if (user && !pendingBoundTo(pending, user)) {
      delete req.session.oauthPending;
      await saveSession(req);
      return sendJson(res, 400, { ok: false, error: 'NO_PENDING', message: 'No pending authorization request' });
    }
    let planOk = false;
    let planError = null;
    if (user) {
      try {
        const billing = require('../billing');
        const { isPaidPlan } = require('../plans');
        const planId = await billing.effectivePlan(user.workspace_id, { email: user.email });
        planOk = isPaidPlan(planId);
        if (!planOk) planError = 'A paid plan (Standard, Pro, or Premium) is required for MCP.';
      } catch (e) {
        planOk = false;
        planError = e.message;
      }
    }
    sendJson(res, 200, {
      ok: true,
      pending: {
        client_id: pending.client_id,
        client_name: pending.client_name,
        redirect_host: pending.redirect_host,
        scope: pending.scope,
        resource: pending.resource,
      },
      client: user ? portal.publicClient(user) : null,
      planOk,
      planError,
    });
  } catch (e) {
    // Batch 143: mask internals (Batch 54 discipline), keep the detail server-side.
    console.error('[oauth/pending] failed:', e && e.message ? e.message : e);
    sendJson(res, 500, { ok: false, error: 'INTERNAL' });
  }
});

sessionRouter.post('/oauth/consent', consentLimit, async (req, res) => {
  try {
    const pending = pendingAlive(req);
    if (!pending) {
      return sendJson(res, 400, { ok: false, error: 'NO_PENDING' });
    }
    const user = await loadPortalUser(req);
    if (!user) {
      return sendJson(res, 401, { ok: false, error: 'AUTH_REQUIRED', message: 'Sign in to the client portal first' });
    }
    // Batch 180 (L2): consent fixation — the parked request must
    // have been parked for THIS user (see pendingBoundTo). A
    // mismatched or pre-auth park is destroyed, never consented.
    if (!pendingBoundTo(pending, user)) {
      delete req.session.oauthPending;
      await saveSession(req);
      return sendJson(res, 403, {
        ok: false,
        error: 'PENDING_USER_MISMATCH',
        message: 'This authorization request was not started for your account. Start again from the app while signed in.',
      });
    }

    const approve = !!(
      req.body &&
      (req.body.approve === true || req.body.approve === '1' || req.body.approve === 'true')
    );
    if (!approve) {
      delete req.session.oauthPending;
      await saveSession(req);
      return sendJson(res, 200, {
        ok: true,
        redirect: oauth.oauthErrorRedirect(
          pending.redirect_uri,
          pending.state,
          'access_denied',
          'The user denied the request'
        ),
      });
    }

    // Plan check happens when minting at /token; fail early here for UX.
    try {
      const billing = require('../billing');
      const { isPaidPlan } = require('../plans');
      const planId = await billing.effectivePlan(user.workspace_id, { email: user.email });
      if (!isPaidPlan(planId)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'PLAN_REQUIRED',
          message: 'Upgrade to a paid plan (Standard, Pro, or Premium) to connect MCP.',
        });
      }
    } catch (e) {
      return sendJson(res, 403, { ok: false, error: e.code || 'FORBIDDEN', message: e.message });
    }

    const code = await oauth.createAuthorizationCode(pending, user);
    delete req.session.oauthPending;
    await saveSession(req);
    return sendJson(res, 200, {
      ok: true,
      redirect: oauth.successRedirect(pending.redirect_uri, pending.state, code),
    });
  } catch (e) {
    console.warn('[mcp-oauth] consent:', e.message);
    return sendJson(res, 500, { ok: false, error: 'CONSENT_FAILED', message: 'Could not complete authorization' });
  }
});

function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== 'function') return resolve();
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { publicRouter, sessionRouter };
