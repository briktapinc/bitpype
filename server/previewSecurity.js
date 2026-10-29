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
 * Batch 27 → Batch 64: an archived (soft-deleted) site's public preview
 * must not serve. Preview folders carry the site id:
 *   ws-{ws}-site-{id}          canonical export folder (no slug)
 *   ws-{ws}-site-{id}-{slug}   canonical export folder (export_slug suffix)
 *   site-{id} / qa-site-{id}   screenshots + QA preview dirs (workspace 1)
 *   {slug}-{id}                legacy export folders (workspace 1)
 * When an id resolves, look the site up in its workspace and answer
 * 410 SITE_ARCHIVED — the same status + body the public module API
 * returns (server/siteModules.js assertSiteNotArchived) — when
 * archived_at is set. Anything unresolvable or any lookup failure
 * falls through unchanged, so a missing folder still 404s downstream.
 *
 * Batch 64 fix: the Batch 27 regex required the id at the very END of
 * the folder name, so the canonical {id}-{exportSlug} folders never
 * matched and archived sites kept serving their full preview (found by
 * Ely's delete test, 2026-10-29: /site-previews/ws-1-site-27-…/ 200
 * while site 27 was archived). Resolution is now anchored at the
 * folder-name START for the ws-/site- shapes, so sibling ids can never
 * be misread (site-270 never resolves as site 27).
 *
 * Deliberately NOT resolved: ws-{ws}-design-{jobId} folders — design-job
 * preview artifacts, generated only for jobs with no linked website row
 * (domain.js designPreview routes linked jobs through the site's own
 * canonical folder, which IS gated). website-promo/ brochure assets
 * encode no website id either; both fall through unchanged.
 */
const SITE_ARCHIVED_BODY = {
  ok: false,
  code: 'SITE_ARCHIVED',
  error: 'This site is no longer available',
};

function resolvePreviewSite(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean)[0] || '';
  let m = seg.match(/^ws-(\d+)-site-(\d+)(?:-|$)/);
  if (m) return { workspaceId: Number(m[1]), siteId: Number(m[2]) };
  m = seg.match(/^(?:qa-)?site-(\d+)(?:-|$)/);
  if (m) return { workspaceId: 1, siteId: Number(m[1]) };
  // Legacy {slug}-{id}: trailing id only, and never inside the ws-*
  // namespace (ws-{ws}-design-{job} must not resolve as a website).
  if (!/^ws-\d+-/.test(seg)) {
    m = seg.match(/-(\d+)$/);
    if (m) return { workspaceId: 1, siteId: Number(m[1]) };
  }
  return null;
}

function blockArchivedPreviews(req, res, next) {
  try {
    const target = resolvePreviewSite(req.path);
    if (!target) return next();
    const db = require('./workspaceDb').openWorkspaceDb(target.workspaceId);
    const row = db.prepare('SELECT archived_at FROM websites WHERE id = ?').get(target.siteId);
    if (row && row.archived_at) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(410).json({ ...SITE_ARCHIVED_BODY });
    }
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

module.exports = {
  rejectOpaqueAppRequests,
  isolateStaticPreview,
  blockArchivedPreviews,
  resolvePreviewSite,
  SITE_ARCHIVED_BODY,
  CAPTCHA_CSP,
};
