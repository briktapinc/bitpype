'use strict';

/**
 * Batch 46 — Google Business Profile manager (staff surface).
 *
 * Mounted at /api/v1/gbp in server.js. The OAuth callback is defined
 * BEFORE the workspace middleware: Google redirects the browser back
 * with only ?code&state, and the signed state (src/gbp signState,
 * Meta-flow pattern) names the workspace whose DB the callback opens.
 * Everything else requires a staff SESSION (requireWorkspace +
 * requireSubscription like the other /api/v1 surfaces, then a session
 * check — workspace API tokens never drive the GBP panels).
 *
 * Mutations: connection changes + push are owner/admin; drafts and
 * validation are open to any staff member of the workspace. Push calls
 * the engine with NO google client — Phase 2 wires the live Business
 * Profile API client; until then an approved flag still answers
 * PUSH_NOT_WIRED rather than pretending to send.
 */

const express = require('express');
const platform = require('../platform');
const { openWorkspaceDb } = require('../workspaceDb');
const { assertWorkspaceExists } = require('../workspaceExists');
const { requireWorkspace, requireSubscription } = require('../middleware');
const gbp = require('../../src/gbp');
const apiErrors = require('../apiErrors');

const router = express.Router();

/** Platform GBP configuration (Admin → Google Business settings). */
async function loadGbpConfig() {
  const [clientId, clientSecret, projectNumber, approvalState, approvedAt, placesKey] =
    await Promise.all([
      platform.getPlatformSetting('gbp.oauth_client_id', ''),
      platform.getPlatformSetting('gbp.oauth_client_secret', ''),
      platform.getPlatformSetting('gbp.cloud_project_number', ''),
      platform.getPlatformSetting('gbp.api_approval_state', 'pending'),
      platform.getPlatformSetting('gbp.api_approved_at', ''),
      platform.getPlatformSetting('google.places_api_key', ''),
    ]);
  return {
    clientId: String(clientId || '').trim(),
    clientSecret: (clientSecret || '').trim(),
    projectNumber: String(projectNumber || '').trim(),
    approvalState: approvalState === 'approved' ? 'approved' : 'pending',
    approvedAt: String(approvedAt || '').trim(),
    placesApiKey: String(placesKey || '').trim(),
  };
}

function requestAppUrl(req) {
  // Batch 56: OAuth redirect URIs must be the canonical public URL (the one
  // registered with Google), not whatever host the admin happened to use —
  // resolve from the single public-URL resolver. `req` is kept in the
  // signature for the existing callers.
  void req;
  return require('../stripeClient').appUrl();
}

function ok(res, data) {
  res.json({ ok: true, data });
}

function fail(res, e) {
  const http = e && e.code === 'NOT_FOUND' ? 404 : e && e.code === 'FORBIDDEN' ? 403 : 400;
  apiErrors.sendError(res, e, http, { area: 'gbp' });
}

/** Only same-app destinations may ride the OAuth state back out. */
function safeReturnPath(raw) {
  const v = String(raw || '').trim();
  if (v.startsWith('/app') || v.startsWith('/portal') || v.startsWith('#/')) return v;
  return '/app#/leads';
}

// ---------------------------------------------------------------------------
// OAuth callback (public; state-signed, see header).
// ---------------------------------------------------------------------------

router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query || {};
    if (error) {
      // Batch 168 (external review F02): never reflect the query
      // param — res.send(string) is text/html; a crafted callback
      // link was a reflected XSS in this origin. Log + fixed line.
      console.warn('[gbp oauth] provider error:', String(error));
      return res.status(400).send('Google sign-in was not completed. You can close this tab and try again.');
    }
    if (!code || !state) return res.status(400).send('Missing code or state');
    const st = gbp.verifyState(String(state));
    await assertWorkspaceExists(Number(st.w));
    const cfg = await loadGbpConfig();
    const db = openWorkspaceDb(Number(st.w));
    const result = await gbp.handleOauthCallback(db, {
      code: String(code),
      state: String(state),
      cfg,
      appUrl: requestAppUrl(req),
    });
    return res.redirect(safeReturnPath(result.returnTo));
  } catch (e) {
    console.error('[gbp oauth]', e);
    // Batch 168 (S2#9): never echo the raw provider/internal message
    // to the browser — it is logged above; the page gets a generic line.
    return res.status(400).send('Google connection failed. Please try again from the Google Business page.');
  }
});

// ---------------------------------------------------------------------------
// Everything below: staff session + workspace (+ subscription gate,
// same stack as the domain API).
// ---------------------------------------------------------------------------

router.use(requireWorkspace, requireSubscription);

router.use((req, res, next) => {
  if (!req.auth || req.auth.via !== 'session') {
    return res
      .status(403)
      .json({ ok: false, error: 'A staff session is required for Google Profile tools.', code: 'FORBIDDEN' });
  }
  return next();
});

function requireOwnerAdmin(req, res, next) {
  if (!['owner', 'admin'].includes(req.auth.role)) {
    return res
      .status(403)
      .json({ ok: false, error: 'Owner or admin role required for this action.', code: 'FORBIDDEN' });
  }
  return next();
}

function db(req) {
  return openWorkspaceDb(req.auth.workspaceId);
}

function leadId(req) {
  const id = Number(req.params.leadId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Invalid lead id'), { code: 'VALIDATION' });
  return id;
}

/** Admin roll-up: connection status across the workspace's leads. */
router.get('/overview', async (req, res) => {
  try {
    const cfg = await loadGbpConfig();
    ok(res, {
      config: gbp.configSummary(cfg, !!cfg.placesApiKey),
      ...gbp.overview(db(req), { page: req.query.page, pageSize: req.query.pageSize }),
    });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/leads/:leadId', async (req, res) => {
  try {
    const cfg = await loadGbpConfig();
    ok(res, gbp.panelData(db(req), leadId(req), { cfg, placesConfigured: !!cfg.placesApiKey }));
  } catch (e) {
    fail(res, e);
  }
});

/** Explicit Places prefill refresh (dormant codes pass through as data,
 * not errors — "no key yet" is a state, not a failure). */
router.post('/leads/:leadId/places-prefill', async (req, res) => {
  try {
    const cfg = await loadGbpConfig();
    const wsDb = db(req);
    const id = leadId(req);
    const places = await gbp.placesPrefillForLead(wsDb, id, { apiKey: cfg.placesApiKey });
    const panel = gbp.panelData(wsDb, id, {
      cfg,
      placesConfigured: !!cfg.placesApiKey,
      placesState: places.ok ? places.state : null,
    });
    ok(res, { places: { ok: places.ok, code: places.code, message: places.message, meta: places.meta || null }, panel });
  } catch (e) {
    fail(res, e);
  }
});

router.put('/leads/:leadId/connection', requireOwnerAdmin, async (req, res) => {
  try {
    const wsDb = db(req);
    const id = leadId(req);
    const body = req.body || {};
    let conn;
    if (body.action === 'invite') conn = gbp.recordManagerInvite(wsDb, id);
    else if (body.action === 'disconnect') conn = gbp.disconnect(wsDb, id);
    else if (body.place_id !== undefined || body.placeId !== undefined) {
      conn = gbp.setConnectionPlaceId(wsDb, id, body.place_id != null ? body.place_id : body.placeId);
    } else {
      throw Object.assign(new Error('Nothing to update — pass place_id or an action.'), { code: 'VALIDATION' });
    }
    ok(res, { connection: conn });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/leads/:leadId/oauth/start', async (req, res) => {
  try {
    const cfg = await loadGbpConfig();
    const id = leadId(req);
    ok(
      res,
      gbp.buildOauthStart(db(req), {
        workspaceId: req.auth.workspaceId,
        leadId: id,
        actor: `staff:${req.auth.userId}`,
        returnTo: `/app#/leads/${id}?gbp=connected`,
        cfg,
        appUrl: requestAppUrl(req),
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/leads/:leadId/change-sets', async (req, res) => {
  try {
    const cs = gbp.createChangeSet(db(req), leadId(req), {
      author: `staff:${req.auth.userId}`,
      state: (req.body || {}).state || {},
    });
    ok(res, { changeSet: cs });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/leads/:leadId/change-sets', async (req, res) => {
  try {
    ok(
      res,
      gbp.listChangeSets(db(req), leadId(req), { page: req.query.page, pageSize: req.query.pageSize })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.get('/leads/:leadId/change-sets/:id', async (req, res) => {
  try {
    const cs = gbp.getChangeSetForLead(db(req), leadId(req), Number(req.params.id));
    if (!cs) throw Object.assign(new Error('Change set not found'), { code: 'NOT_FOUND' });
    ok(res, { changeSet: cs });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/leads/:leadId/change-sets/:id/validate', async (req, res) => {
  try {
    const wsDb = db(req);
    const cs = gbp.getChangeSetForLead(wsDb, leadId(req), Number(req.params.id));
    if (!cs) throw Object.assign(new Error('Change set not found'), { code: 'NOT_FOUND' });
    ok(res, gbp.validateChangeSet(wsDb, cs.id));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/leads/:leadId/change-sets/:id/push', requireOwnerAdmin, async (req, res) => {
  try {
    const cfg = await loadGbpConfig();
    const wsDb = db(req);
    const cs = gbp.getChangeSetForLead(wsDb, leadId(req), Number(req.params.id));
    if (!cs) throw Object.assign(new Error('Change set not found'), { code: 'NOT_FOUND' });
    ok(res, await gbp.pushChangeSet(wsDb, cs.id, { approvalState: cfg.approvalState, googleClient: null }));
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
module.exports.loadGbpConfig = loadGbpConfig;
module.exports.requestAppUrl = requestAppUrl;
