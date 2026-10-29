'use strict';

/**
 * Batch 59 — public Hostinger deployment endpoints:
 *   POST /api/v1/hostinger-deploy/callback — a customer VM's install
 *     script phones home (ready + one-time setup token, or failed +
 *     stage). Authenticated by a per-deployment secret whose SHA-256
 *     hash is the only copy this server keeps.
 *   GET  /api/v1/hostinger-deploy/bundle?token=… — the same VM
 *     downloads the app's source bundle once, authenticated by a
 *     second per-deployment token (hash-stored the same way). A wrong
 *     or stale token is a plain 404 — no deployment details leak.
 *
 * Both endpoints are rate-limited by the shared public-form limiter
 * and report errors through the Batch 54 apiErrors discipline
 * (uncoded 5xx never reach the caller raw).
 */

const express = require('express');
const apiErrors = require('../apiErrors');
const deploy = require('../hostingerDeploy');

const router = express.Router();

function fail(res, err, fallbackStatus = 400) {
  const http = err && err.code === 'NOT_FOUND' ? 404 : err && err.code === 'CALLBACK_AUTH' ? 403 : fallbackStatus;
  return apiErrors.sendError(res, err, http, { area: 'hostinger-callback' });
}

router.post('/callback', async (req, res) => {
  try {
    const out = await deploy.handleCallback(req.body || {});
    return res.json({ ok: true, already: !!out.already, status: out.deployment ? out.deployment.status : '' });
  } catch (e) {
    const status = e.code === 'CALLBACK_AUTH' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
    return fail(res, e, status);
  }
});

router.get('/bundle', async (req, res) => {
  try {
    const dep = await deploy.findDeploymentByBundleToken(String((req.query && req.query.token) || ''));
    if (!dep) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Bundle not found.' } });
    return deploy.streamBundle(res);
  } catch (e) {
    return fail(res, e, 500);
  }
});

module.exports = router;
