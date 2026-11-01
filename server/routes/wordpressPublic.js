// @ts-check
'use strict';

/**
 * Batch 114 — WordPress connector plugin API (server-to-server; the
 * callers are WordPress sites running the BitPype Connector plugin,
 * never browsers).
 *
 *   POST /register    spend a download's registration token, bind it
 *                     to one WP site, return the derived site key.
 *   GET  /forms       (site key) this workspace's renderable forms.
 *   POST /ping        (site key) lifecycle signal: active | status |
 *                     deactivated | uninstalled.
 *   POST /disconnect  (site key) owner disconnect from WP admin.
 *
 * Auth is the scoped site credential only (X-Bitpype-Site-Key header
 * or Authorization: Bearer). A revoked site fails closed here with
 * 410 SITE_REVOKED — that refusal IS the plugin's disconnect signal.
 */

const express = require('express');
const wpPlugin = require('../wpPlugin');
const { rateLimit } = require('../rateLimit');
const apiErrors = require('../apiErrors');

const router = express.Router();
const registerLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const siteLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });

function fail(res, e, status = 400) {
  const http =
    e.code === 'NOT_FOUND' || e.code === 'INVALID_LINK'
      ? 404
      : e.code === 'INVALID_SITE_KEY'
        ? 401
        : e.code === 'TOKEN_SPENT'
          ? 409
          : e.code === 'LINK_REVOKED' || e.code === 'SITE_REVOKED'
            ? 410
            : typeof e.status === 'number'
              ? e.status
              : status;
  apiErrors.sendError(res, e, http, { area: 'wordpressPublic', mask5xx: true });
}

function siteKeyFromReq(req) {
  const header = String(req.get('x-bitpype-site-key') || '').trim();
  if (header) return header;
  const auth = String(req.get('authorization') || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function requireSiteKey(req, res, next) {
  try {
    req.wpSite = await wpPlugin.requireSite(siteKeyFromReq(req));
    return next();
  } catch (e) {
    return fail(res, e);
  }
}

router.post('/register', registerLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const regToken = String(body.token || '');
    const data = await wpPlugin.registerSite({
      token: regToken,
      siteUrl: body.site_url || body.siteUrl,
      siteName: body.site_name || body.siteName,
      adminEmail: body.admin_email || body.adminEmail,
    });
    res.json({
      ok: true,
      data: { site_key: data.siteKey, link_id: data.linkId, site_url: data.siteUrl, status: 'connected' },
    });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/forms', siteLimit, requireSiteKey, async (req, res) => {
  try {
    if (req.wpSite.status !== 'connected') {
      return res.status(409).json({
        ok: false,
        error: 'This site is not currently connected',
        code: 'SITE_DISCONNECTED',
        status: req.wpSite.status,
      });
    }
    const data = await wpPlugin.siteForms(req.wpSite);
    await wpPlugin.pingSite(req.wpSite, 'status');
    res.json({ ok: true, data: { status: 'connected', forms: data.forms, app_url: data.appUrl } });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/ping', siteLimit, requireSiteKey, async (req, res) => {
  try {
    const state = String((req.body && req.body.state) || 'status').toLowerCase();
    if (!['active', 'status', 'deactivated', 'uninstalled'].includes(state)) {
      return res.status(400).json({ ok: false, error: 'Unknown ping state', code: 'INVALID' });
    }
    const data = await wpPlugin.pingSite(req.wpSite, state);
    res.json({ ok: true, data });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/disconnect', siteLimit, requireSiteKey, async (req, res) => {
  try {
    const data = await wpPlugin.disconnectSite(req.wpSite, req.body && req.body.reason);
    res.json({ ok: true, data });
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
