'use strict';

const PUBLIC_PREVIEW_API =
  /^\/api\/v1\/(?:forms\/public|modules\/public|chat\/public|outreach\/public)(?:\/|$)|^\/api\/v1\/captcha\/config\/?$/;
// This public, credential-free bridge must also embed below opaque ancestors.
// frame-ancestors * rejects opaque ancestors; omit that directive here only.
const CAPTCHA_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self' https:; frame-src https://challenges.cloudflare.com; img-src https: data:; base-uri 'none'; form-action 'none'";

function rejectOpaqueAppRequests(req, res, next) {
  if (req.headers.origin !== 'null') return next();
  // Public embeds use tokens, never staff/portal sessions or authorization.
  delete req.headers.cookie;
  delete req.headers.authorization;
  if (/^\/(?:api|mcp|ws|oauth|authorize)(?:\/|$)/i.test(req.path || '') && !PUBLIC_PREVIEW_API.test(req.path || '')) {
    return res
      .status(403)
      .json({ ok: false, code: 'PREVIEW_ORIGIN_DENIED', error: 'Preview cannot access authenticated app APIs' });
  }
  return next();
}

/**
 * Batch 27: an archived (soft-deleted) site's public preview must not serve.
 * Preview folders carry the site id (ws-{ws}-site-{id}, site-{id}, {slug}-{id});
 * when an id parses, look the site up and 404 when archived_at is set.
 * Anything unparseable or any lookup failure falls through unchanged.
 */
function blockArchivedPreviews(req, res, next) {
  try {
    const seg = String(req.path || '').split('/').filter(Boolean)[0] || '';
    const wsMatch = seg.match(/^ws-(\d+)-/);
    const idMatch = seg.match(/-site-(\d+)$/) || seg.match(/^site-(\d+)$/) || seg.match(/-(\d+)$/);
    if (!idMatch) return next();
    const workspaceId = wsMatch ? Number(wsMatch[1]) : 1;
    const db = require('./workspaceDb').openWorkspaceDb(workspaceId);
    const row = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(Number(idMatch[1]));
    if (row && row.archived_at) return res.status(404).send('Not found');
    return next();
  } catch {
    return next();
  }
}

function isolateStaticPreview(req, res, next) {
  // Enforced response policy also protects direct visits outside an iframe.
  res.setHeader(
    'Content-Security-Policy',
    "sandbox allow-scripts allow-forms; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'self'; form-action https:"
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

module.exports = { rejectOpaqueAppRequests, isolateStaticPreview, blockArchivedPreviews, CAPTCHA_CSP };
